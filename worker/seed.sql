INSERT OR IGNORE INTO feeds (url, name, category, enabled, created_at) VALUES
  ('https://www.dawn.com/feeds/business', 'Dawn Business', 'Business', 1, datetime('now')),
  ('https://www.dawn.com/feeds/pakistan', 'Dawn Pakistan', 'Pakistan', 1, datetime('now')),
  ('https://tribune.com.pk/feed/business', 'Express Tribune Business', 'Business', 1, datetime('now')),
  ('https://tribune.com.pk/feed/pakistan', 'Express Tribune Pakistan', 'Pakistan', 1, datetime('now')),
  ('https://propakistani.pk/feed/', 'ProPakistani', 'Tech', 1, datetime('now')),
  ('https://www.techjuice.pk/feed/', 'TechJuice', 'Tech', 1, datetime('now')),
  ('https://www.brecorder.com/feeds/latest-news', 'Business Recorder', 'Business', 1, datetime('now')),
  ('https://www.geo.tv/rss/1/1', 'Geo News', 'Pakistan', 1, datetime('now')),
  ('https://www.arabnews.pk/rss.xml', 'Arab News Pakistan', 'Pakistan', 1, datetime('now'));
