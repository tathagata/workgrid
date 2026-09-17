-- Preserve every existing/custom color. Known palette values acquire stable IDs;
-- unknown values remain valid custom colors with a NULL palette identity.
ALTER TABLE `tasks` ADD `color_id` text;
UPDATE `tasks` SET `color_id` = CASE lower(`color`)
  WHEN '#1d4ed8' THEN 'ocean' WHEN '#4338ca' THEN 'indigo'
  WHEN '#6d28d9' THEN 'violet' WHEN '#7e22ce' THEN 'orchid'
  WHEN '#be185d' THEN 'berry' WHEN '#b91c1c' THEN 'brick'
  WHEN '#c2410c' THEN 'ember' WHEN '#a16207' THEN 'ochre'
  WHEN '#3f6212' THEN 'moss' WHEN '#047857' THEN 'forest'
  WHEN '#0f766e' THEN 'lagoon' WHEN '#475569' THEN 'slate'
  ELSE NULL END;
