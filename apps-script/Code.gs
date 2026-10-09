// Naya News queue: Google Apps Script web app bound to the "Naya News Queue" spreadsheet.
// The pipeline adds collected stories to the Queue tab, posts them from the top one at a time,
// and moves each posted row to the Posted tab. You can reorder, add or delete Queue rows by hand:
// the next post is always the top row. Deploy as a web app (Execute as: Me, Access: Anyone);
// the long deployment URL is the only key, so keep it private.

var QUEUE = 'Queue';
var POSTED = 'Posted';
var Q_HEAD = ['Added', 'Title', 'Source', 'Link', 'Published', 'Category', 'Summary'];
var P_HEAD = ['Posted', 'Result', 'Title', 'Source', 'Link', 'Image'];
var POSTED_KEEP = 1000;

function doGet(e) {
  var p = (e && e.parameter) || {};
  return handle_({ action: p.action || 'list', limit: Number(p.limit || 50) });
}

function doPost(e) {
  var req = {};
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return out_({ ok: false, error: 'invalid JSON' });
  }
  return handle_(req);
}

function handle_(req) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var q = sheet_(QUEUE, Q_HEAD);
    var p = sheet_(POSTED, P_HEAD);
    switch (req.action) {
      case 'list':
        return out_({ ok: true, items: rows_(q).slice(0, req.limit || 50).map(toItem_) });
      case 'append':
        return out_({ ok: true, added: append_(q, p, req.items || []) });
      case 'remove':
        return out_({ ok: true, removed: remove_(q, p, req) });
      case 'prune':
        return out_({ ok: true, removed: prune_(q, Number(req.max_age_hours || 24), Number(req.max_items || 30)) });
      default:
        return out_({ ok: false, error: 'unknown action' });
    }
  } catch (err) {
    return out_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function sheet_(name, head) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh && name === QUEUE && ss.getSheets()[0].getLastRow() === 0) {
    sh = ss.getSheets()[0].setName(QUEUE);  // reuse the empty default tab
    ss.setSpreadsheetTimeZone('Asia/Karachi');
  }
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.appendRow(head);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, head.length).setFontWeight('bold').setBackground('#FFC72C');
  }
  return sh;
}

function rows_(sh) {
  var n = sh.getLastRow() - 1;
  if (n < 1) return [];
  var vals = sh.getRange(2, 1, n, sh.getLastColumn()).getValues();
  return vals.map(function (v, i) { return { row: i + 2, v: v }; })
    .filter(function (r) { return String(r.v[3] || '').indexOf('http') === 0; });
}

function toItem_(r) {
  var v = r.v;
  return { row: r.row, added: iso_(v[0]), title: String(v[1] || ''), source: String(v[2] || ''), link: String(v[3]),
           published: iso_(v[4]), category: String(v[5] || ''), summary: String(v[6] || '') };
}

function iso_(d) {
  return d instanceof Date ? d.toISOString() : (d ? String(d) : '');
}

function linkSet_(sh, col) {
  var n = sh.getLastRow() - 1;
  var set = {};
  if (n < 1) return set;
  sh.getRange(2, col, n, 1).getValues().forEach(function (r) { set[String(r[0])] = true; });
  return set;
}

function append_(q, p, items) {
  var have = linkSet_(q, 4);
  var posted = linkSet_(p, 5);
  var rows = [];
  items.forEach(function (it) {
    var link = String(it.link || '');
    if (link.indexOf('http') !== 0 || have[link] || posted[link]) return;
    have[link] = true;
    rows.push([new Date(), it.title || '', it.source || '', link, it.published ? new Date(it.published) : '',
               it.category || '', String(it.summary || '').slice(0, 1500)]);
  });
  if (rows.length) q.getRange(q.getLastRow() + 1, 1, rows.length, Q_HEAD.length).setValues(rows);
  return rows.length;
}

function remove_(q, p, req) {
  var link = String(req.link || '');
  var removed = 0;
  var title = req.title || '';
  var source = req.source || '';
  var rs = rows_(q);
  for (var i = rs.length - 1; i >= 0; i--) {
    if (String(rs[i].v[3]) === link) {
      title = title || rs[i].v[1];
      source = source || rs[i].v[2];
      q.deleteRow(rs[i].row);
      removed++;
    }
  }
  if (req.result) {
    p.insertRowAfter(1);
    p.getRange(2, 1, 1, P_HEAD.length).setValues([[new Date(), req.result, title, source, link, req.image || '']]);
    if (p.getLastRow() > POSTED_KEEP + 1) p.deleteRows(POSTED_KEEP + 2, p.getLastRow() - POSTED_KEEP - 1);
  }
  return removed;
}

function prune_(q, maxAgeHours, maxItems) {
  var cutoff = new Date(Date.now() - maxAgeHours * 3600 * 1000);
  var rs = rows_(q);
  var removed = 0;
  for (var i = rs.length - 1; i >= 0; i--) {
    var when = rs[i].v[4] instanceof Date ? rs[i].v[4] : rs[i].v[0];
    if (when instanceof Date && when < cutoff) {
      q.deleteRow(rs[i].row);
      removed++;
    }
  }
  // Over the size limit: drop the oldest stories first.
  rs = rows_(q);
  var extra = rs.length - maxItems;
  if (extra > 0) {
    var stamp = function (r) { var w = r.v[4] instanceof Date ? r.v[4] : r.v[0]; return w instanceof Date ? w.getTime() : 0; };
    var victims = rs.slice().sort(function (a, b) { return stamp(a) - stamp(b); }).slice(0, extra)
      .map(function (r) { return r.row; }).sort(function (a, b) { return b - a; });
    victims.forEach(function (row) { q.deleteRow(row); });
    removed += victims.length;
  }
  return removed;
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Run once from the editor (Run > setup) to create the tabs and set the time zone.
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone('Asia/Karachi');
  sheet_(QUEUE, Q_HEAD);
  sheet_(POSTED, P_HEAD);
  var first = ss.getSheetByName('Sheet1');
  if (first && ss.getSheets().length > 2 && first.getLastRow() === 0) ss.deleteSheet(first);
}
