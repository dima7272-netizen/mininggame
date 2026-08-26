ALTER TABLE `versions` ADD `version_name` text DEFAULT 'Обновление' NOT NULL;--> statement-breakpoint
ALTER TABLE `versions` ADD `notes` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `versions` ADD `change_summary_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `versions` ADD `rollback_target_version_id` text;--> statement-breakpoint
UPDATE `versions`
SET `version_name` = CASE
	WHEN `source` = 'github_import' THEN 'Стартовый импорт'
	WHEN `source` = 'rollback' THEN 'Откат версии'
	ELSE `comment`
END,
`notes` = `comment`
WHERE `version_name` = 'Обновление' AND `notes` = '';
