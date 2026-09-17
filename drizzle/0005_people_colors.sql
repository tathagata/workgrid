-- Preserve legacy/custom colors while attaching stable identities to known values.
ALTER TABLE `people` ADD `color_id` text;
UPDATE `people` SET `color_id` = CASE lower(`color`)
  WHEN '#2f6f65' THEN 'pine' WHEN '#5b67a5' THEN 'denim'
  WHEN '#8b5d33' THEN 'walnut' WHEN '#96585b' THEN 'rosewood'
  WHEN '#6d6a55' THEN 'olive' WHEN '#695488' THEN 'plum'
  WHEN '#1e3a8a' THEN 'navy' WHEN '#5b21b6' THEN 'iris'
  WHEN '#9d174d' THEN 'mulberry' WHEN '#9a3412' THEN 'cedar'
  WHEN '#3f6212' THEN 'fern' WHEN '#155e75' THEN 'harbor'
  ELSE NULL END;
