CREATE TABLE `commit_status` (
	`sha` text NOT NULL,
	`context` text NOT NULL,
	`state` text NOT NULL,
	`description` text,
	`target_url` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`sha`, `context`),
	CONSTRAINT "chk_commit_status_state" CHECK("state" IN ('pending','success','failure','error'))
);
--> statement-breakpoint
CREATE TABLE `discussion_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`discussion_id` text NOT NULL,
	`body` text NOT NULL,
	`author` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`discussion_id`) REFERENCES `discussions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_discussion_comments_discussion` ON `discussion_comments` (`discussion_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `discussions` (
	`id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`category` text DEFAULT 'general' NOT NULL,
	`author` text NOT NULL,
	`answer_comment_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "chk_discussions_category" CHECK("category" IN ('general','announcements','ideas','q-a','show-and-tell','polls')),
	CONSTRAINT "chk_discussions_number" CHECK("number" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_discussions_number` ON `discussions` (`number`);--> statement-breakpoint
CREATE INDEX `idx_discussions_category` ON `discussions` (`category`,"number" desc);--> statement-breakpoint
CREATE INDEX `idx_discussions_created` ON `discussions` ("created_at" desc);--> statement-breakpoint
CREATE TABLE `issue_assignees` (
	`issue_id` text NOT NULL,
	`assignee` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`issue_id`, `assignee`),
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_issue_assignees_user` ON `issue_assignees` (`assignee`);--> statement-breakpoint
CREATE TABLE `issue_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`body` text NOT NULL,
	`author` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_issue_comments_issue` ON `issue_comments` (`issue_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `issue_labels` (
	`issue_id` text NOT NULL,
	`label_id` text NOT NULL,
	PRIMARY KEY(`issue_id`, `label_id`),
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`label_id`) REFERENCES `labels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_issue_labels_label` ON `issue_labels` (`label_id`);--> statement-breakpoint
CREATE TABLE `issues` (
	`id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`state` text DEFAULT 'open' NOT NULL,
	`state_reason` text,
	`author` text NOT NULL,
	`work_intent_id` text,
	`milestone_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`closed_at` integer,
	`closed_by` text,
	CONSTRAINT "chk_issues_state" CHECK("state" IN ('open','closed')),
	CONSTRAINT "chk_issues_state_reason" CHECK("state_reason" IS NULL OR "state_reason" IN ('completed','not_planned','reopened')),
	CONSTRAINT "chk_issues_number" CHECK("number" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_issues_number` ON `issues` (`number`);--> statement-breakpoint
CREATE INDEX `idx_issues_state_number` ON `issues` (`state`,"number" desc);--> statement-breakpoint
CREATE INDEX `idx_issues_milestone` ON `issues` (`milestone_id`);--> statement-breakpoint
CREATE INDEX `idx_issues_work_intent` ON `issues` (`work_intent_id`);--> statement-breakpoint
CREATE TABLE `labels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`description` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_labels_name` ON `labels` (`name`);--> statement-breakpoint
CREATE TABLE `match_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`match_id` text NOT NULL,
	`entrant_did` text NOT NULL,
	`workspace_name` text NOT NULL,
	`head_oid` text,
	`push_count` integer DEFAULT 0 NOT NULL,
	`first_push_at` integer,
	`last_push_at` integer,
	`auto_score` integer DEFAULT 0 NOT NULL,
	`vote_count` integer DEFAULT 0 NOT NULL,
	`won` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_match_entries_match` ON `match_entries` (`match_id`);--> statement-breakpoint
CREATE INDEX `idx_match_entries_did` ON `match_entries` (`entrant_did`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_match_entries_match_did` ON `match_entries` (`match_id`,`entrant_did`);--> statement-breakpoint
CREATE TABLE `match_votes` (
	`match_id` text NOT NULL,
	`voter_did` text NOT NULL,
	`entry_id` text NOT NULL,
	`stake` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`match_id`, `voter_did`),
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_match_votes_entry` ON `match_votes` (`entry_id`);--> statement-breakpoint
CREATE TABLE `matches` (
	`id` text PRIMARY KEY NOT NULL,
	`do_name` text NOT NULL,
	`title` text NOT NULL,
	`spec` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`window_minutes` integer NOT NULL,
	`judge_minutes` integer NOT NULL,
	`max_entrants` integer NOT NULL,
	`prize_rep` integer NOT NULL,
	`prize_wei` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`ends_at` integer,
	`judge_ends_at` integer,
	`winner_entry_id` text,
	CONSTRAINT "chk_matches_status" CHECK("status" IN ('open','building','judging','resolved','expired'))
);
--> statement-breakpoint
CREATE INDEX `idx_matches_status` ON `matches` (`status`,`ends_at`);--> statement-breakpoint
CREATE TABLE `merge_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`target_ref` text NOT NULL,
	`base_oid` text NOT NULL,
	`delta_ref` text NOT NULL,
	`delta_oid` text NOT NULL,
	`actor` text NOT NULL,
	`status` text NOT NULL,
	`conflicts` text,
	`result_oid` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`resolved_at` integer,
	CONSTRAINT "chk_merge_intents_status" CHECK("status" IN ('open','merging','adjudicating','merged','conflict','expired','rejected'))
);
--> statement-breakpoint
CREATE INDEX `idx_merge_intents_status_expiry` ON `merge_intents` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_merge_intents_target_status` ON `merge_intents` (`target_ref`,`status`);--> statement-breakpoint
CREATE TABLE `merge_votes` (
	`intent_id` text NOT NULL,
	`seat` integer NOT NULL,
	`voter_did` text NOT NULL,
	`resolution_digest` text NOT NULL,
	`rationale` text,
	`signature` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`intent_id`, `seat`),
	CONSTRAINT "chk_merge_votes_seat" CHECK("seat" >= 1)
);
--> statement-breakpoint
CREATE INDEX `idx_merge_votes_intent_digest` ON `merge_votes` (`intent_id`,`resolution_digest`);--> statement-breakpoint
CREATE TABLE `milestones` (
	`id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`state` text DEFAULT 'open' NOT NULL,
	`due_on` integer,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`closed_at` integer,
	CONSTRAINT "chk_milestones_state" CHECK("state" IN ('open','closed')),
	CONSTRAINT "chk_milestones_number" CHECK("number" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_milestones_number` ON `milestones` (`number`);--> statement-breakpoint
CREATE INDEX `idx_milestones_state` ON `milestones` (`state`);--> statement-breakpoint
CREATE TABLE `op_log` (
	`seq` integer PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`prev_hash` text NOT NULL,
	`kind` text NOT NULL,
	`actor` text,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "chk_op_log_seq" CHECK("seq" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_op_log_kind_created` ON `op_log` (`kind`,`created_at`);--> statement-breakpoint
CREATE TABLE `pack_catalog` (
	`pack_key` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`tier` integer NOT NULL,
	`seq_lo` integer NOT NULL,
	`seq_hi` integer NOT NULL,
	`object_count` integer NOT NULL,
	`pack_bytes` integer NOT NULL,
	`idx_bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	`superseded_by` text,
	CONSTRAINT "chk_pack_catalog_kind" CHECK("kind" IN ('receive','compact','legacy')),
	CONSTRAINT "chk_pack_catalog_state" CHECK("state" IN ('active','superseded')),
	CONSTRAINT "chk_pack_catalog_tier" CHECK("tier" >= 0),
	CONSTRAINT "chk_pack_catalog_seq" CHECK("seq_lo" <= "seq_hi"),
	CONSTRAINT "chk_pack_catalog_object_count" CHECK("object_count" >= 0),
	CONSTRAINT "chk_pack_catalog_pack_bytes" CHECK("pack_bytes" >= 0),
	CONSTRAINT "chk_pack_catalog_idx_bytes" CHECK("idx_bytes" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_pack_catalog_state_seqhi` ON `pack_catalog` (`state`,"seq_hi" desc);--> statement-breakpoint
CREATE INDEX `idx_pack_catalog_state_tier_seqlo` ON `pack_catalog` (`state`,`tier`,`seq_lo`);--> statement-breakpoint
CREATE TABLE `processed_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `project_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`column_id` text NOT NULL,
	`kind` text NOT NULL,
	`issue_number` integer,
	`note` text,
	`position` integer NOT NULL,
	`author` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`column_id`) REFERENCES `project_columns`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_project_cards_kind" CHECK("kind" IN ('issue','note'))
);
--> statement-breakpoint
CREATE INDEX `idx_project_cards_column` ON `project_cards` (`column_id`,`position`);--> statement-breakpoint
CREATE TABLE `project_columns` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_project_columns_project` ON `project_columns` (`project_id`,`position`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`state` text DEFAULT 'open' NOT NULL,
	`author` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "chk_projects_state" CHECK("state" IN ('open','closed')),
	CONSTRAINT "chk_projects_number" CHECK("number" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_projects_number` ON `projects` (`number`);--> statement-breakpoint
CREATE INDEX `idx_projects_state` ON `projects` (`state`,"number" desc);--> statement-breakpoint
CREATE TABLE `reactions` (
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`reaction` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`target_type`, `target_id`, `reaction`, `actor`),
	CONSTRAINT "chk_reactions_type" CHECK("target_type" IN ('issue','issue_comment','merge_intent','work_intent','discussion','discussion_comment')),
	CONSTRAINT "chk_reactions_kind" CHECK("reaction" IN ('+1','-1','laugh','hooray','confused','heart','rocket','eyes'))
);
--> statement-breakpoint
CREATE INDEX `idx_reactions_target` ON `reactions` (`target_type`,`target_id`);--> statement-breakpoint
CREATE TABLE `release_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`release_id` text NOT NULL,
	`name` text NOT NULL,
	`content_type` text DEFAULT 'application/octet-stream' NOT NULL,
	`size` integer NOT NULL,
	`r2_key` text NOT NULL,
	`download_count` integer DEFAULT 0 NOT NULL,
	`author` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`release_id`) REFERENCES `releases`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_release_assets_size" CHECK("size" >= 0),
	CONSTRAINT "chk_release_assets_downloads" CHECK("download_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_release_assets_name` ON `release_assets` (`release_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_release_assets_release` ON `release_assets` (`release_id`);--> statement-breakpoint
CREATE TABLE `releases` (
	`id` text PRIMARY KEY NOT NULL,
	`tag_name` text NOT NULL,
	`target_oid` text,
	`name` text NOT NULL,
	`body` text,
	`draft` integer DEFAULT 0 NOT NULL,
	`prerelease` integer DEFAULT 0 NOT NULL,
	`author` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "chk_releases_draft" CHECK("draft" IN (0,1)),
	CONSTRAINT "chk_releases_prerelease" CHECK("prerelease" IN (0,1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_releases_tag` ON `releases` (`tag_name`);--> statement-breakpoint
CREATE INDEX `idx_releases_created` ON `releases` ("created_at" desc);--> statement-breakpoint
CREATE TABLE `repo_secrets` (
	`name` text PRIMARY KEY NOT NULL,
	`ciphertext` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `webhook_subs` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`events` text NOT NULL,
	`secret` text,
	`created_by` text NOT NULL,
	`active` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "chk_webhook_subs_active" CHECK("active" IN (0,1))
);
--> statement-breakpoint
CREATE INDEX `idx_webhook_subs_active` ON `webhook_subs` (`active`);--> statement-breakpoint
CREATE TABLE `work_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`created_by` text NOT NULL,
	`kind` text DEFAULT 'work' NOT NULL,
	`source_uri` text,
	`result` text,
	`status` text NOT NULL,
	`claimed_by` text,
	`claim_expires_at` integer,
	`reward_wei` text,
	`created_at` integer NOT NULL,
	`closed_at` integer,
	CONSTRAINT "chk_work_intents_status" CHECK("status" IN ('open','claimed','closed','verified')),
	CONSTRAINT "chk_work_intents_kind" CHECK("kind" IN ('work','idea','issue','verify'))
);
--> statement-breakpoint
CREATE INDEX `idx_work_intents_status` ON `work_intents` (`status`);--> statement-breakpoint
CREATE INDEX `idx_work_intents_kind_status` ON `work_intents` (`kind`,`status`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`artifacts_name` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`owner_did` text NOT NULL,
	`work_intent_id` text,
	`match_id` text,
	`head_oid` text,
	`push_count` integer DEFAULT 0 NOT NULL,
	`first_push_at` integer,
	`last_push_at` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "chk_workspaces_kind" CHECK("kind" IN ('task','arena')),
	CONSTRAINT "chk_workspaces_status" CHECK("status" IN ('open','merged','expired','deleted'))
);
--> statement-breakpoint
CREATE INDEX `idx_workspaces_match` ON `workspaces` (`match_id`);--> statement-breakpoint
CREATE INDEX `idx_workspaces_status` ON `workspaces` (`status`);