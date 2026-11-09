CREATE TABLE `agents` (
	`did` text PRIMARY KEY NOT NULL,
	`pubkey` text NOT NULL,
	`label` text,
	`owner_did` text,
	`kind` text DEFAULT 'agent' NOT NULL,
	`family` text,
	`model` text,
	`family_verified` integer DEFAULT 0 NOT NULL,
	`rep` integer DEFAULT 0 NOT NULL,
	`banned` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer,
	CONSTRAINT "chk_agents_banned" CHECK("banned" IN (0,1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_agents_pubkey` ON `agents` (`pubkey`);--> statement-breakpoint
CREATE INDEX `idx_agents_rep` ON `agents` (`rep`);--> statement-breakpoint
CREATE TABLE `arena_matches` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`do_name` text NOT NULL,
	`owner_slug` text NOT NULL,
	`repo_slug` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'building' NOT NULL,
	`entry_count` integer DEFAULT 0 NOT NULL,
	`ends_at` integer,
	`judge_ends_at` integer,
	`winner_entry_id` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_arena_matches_status` ON `arena_matches` (`status`,`ends_at`);--> statement-breakpoint
CREATE INDEX `idx_arena_matches_repo` ON `arena_matches` (`repository_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`tessera_sub` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_tessera_sub_unique` ON `users` (`tessera_sub`);--> statement-breakpoint
CREATE TABLE `namespaces` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`created_by` text NOT NULL,
	`owner_did` text,
	`description` text,
	`website` text,
	`avatar_url` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `namespaces_slug_unique` ON `namespaces` (`slug`);--> statement-breakpoint
CREATE TABLE `namespace_memberships` (
	`namespace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'owner' NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`namespace_id`, `user_id`),
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_namespace_memberships_user_ns` ON `namespace_memberships` (`user_id`,`namespace_id`);--> statement-breakpoint
CREATE TABLE `did_sessions` (
	`jti` text PRIMARY KEY NOT NULL,
	`did` text NOT NULL,
	`dpop_jkt` text,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`did`) REFERENCES `identities`(`did`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_did_sessions_did` ON `did_sessions` (`did`);--> statement-breakpoint
CREATE TABLE `identities` (
	`did` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`handle` text,
	`device_keys` text DEFAULT '[]' NOT NULL,
	`rep` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_identities_handle` ON `identities` (`handle`);--> statement-breakpoint
CREATE TABLE `repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`created_by` text NOT NULL,
	`slug` text NOT NULL,
	`do_name` text NOT NULL,
	`did` text,
	`mirror_targets` text,
	`visibility` text NOT NULL,
	`encrypted` integer DEFAULT 0 NOT NULL,
	`description` text,
	`website` text,
	`forked_from_id` text,
	`is_gist` integer DEFAULT 0 NOT NULL,
	`backend` text DEFAULT 'do' NOT NULL,
	`artifacts_name` text,
	`artifacts_remote` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "chk_repositories_visibility" CHECK("visibility" IN ('public','private','internal'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_repositories_namespace_slug` ON `repositories` (`namespace_id`,`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_repositories_do_name` ON `repositories` (`do_name`);--> statement-breakpoint
CREATE INDEX `idx_repositories_forked_from` ON `repositories` (`forked_from_id`);--> statement-breakpoint
CREATE INDEX `idx_repositories_namespace_updated` ON `repositories` (`namespace_id`,`updated_at`,`slug`);--> statement-breakpoint
CREATE TABLE `personal_access_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `personal_access_tokens_prefix_unique` ON `personal_access_tokens` (`prefix`);--> statement-breakpoint
CREATE INDEX `idx_pats_user_created` ON `personal_access_tokens` (`user_id`,"created_at" desc);--> statement-breakpoint
CREATE TABLE `pat_namespace_grants` (
	`pat_id` text NOT NULL,
	`namespace_id` text NOT NULL,
	`level` text NOT NULL,
	PRIMARY KEY(`pat_id`, `namespace_id`),
	FOREIGN KEY (`pat_id`) REFERENCES `personal_access_tokens`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_pat_namespace_grants_level" CHECK("level" IN ('pull','push'))
);
--> statement-breakpoint
CREATE INDEX `idx_pat_namespace_grants_namespace` ON `pat_namespace_grants` (`namespace_id`);--> statement-breakpoint
CREATE TABLE `pat_repo_grants` (
	`pat_id` text NOT NULL,
	`repo_id` text NOT NULL,
	`level` text NOT NULL,
	PRIMARY KEY(`pat_id`, `repo_id`),
	FOREIGN KEY (`pat_id`) REFERENCES `personal_access_tokens`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repo_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_pat_repo_grants_level" CHECK("level" IN ('pull','push'))
);
--> statement-breakpoint
CREATE INDEX `idx_pat_repo_grants_repo` ON `pat_repo_grants` (`repo_id`);--> statement-breakpoint
CREATE TABLE `epoch_allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`epoch_id` text NOT NULL,
	`from_did` text NOT NULL,
	`to_did` text NOT NULL,
	`amount` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`epoch_id`) REFERENCES `epochs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_epoch_alloc_amount" CHECK("amount" > 0)
);
--> statement-breakpoint
CREATE INDEX `idx_epoch_allocations_epoch` ON `epoch_allocations` (`epoch_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_epoch_alloc` ON `epoch_allocations` (`epoch_id`,`from_did`,`to_did`);--> statement-breakpoint
CREATE TABLE `epochs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`budget` integer NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`closed_at` integer,
	CONSTRAINT "chk_epochs_status" CHECK("status" IN ('open','closed'))
);
--> statement-breakpoint
CREATE INDEX `idx_epochs_status` ON `epochs` (`status`,`ends_at`);--> statement-breakpoint
CREATE TABLE `vouches` (
	`id` text PRIMARY KEY NOT NULL,
	`from_did` text NOT NULL,
	`to_did` text NOT NULL,
	`kind` text NOT NULL,
	`message` text,
	`signature` text,
	`rep_delta` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "chk_vouches_kind" CHECK("kind" IN ('praise','vouch','flag'))
);
--> statement-breakpoint
CREATE INDEX `idx_vouches_to` ON `vouches` (`to_did`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_vouches_from` ON `vouches` (`from_did`,`created_at`);--> statement-breakpoint
CREATE TABLE `casbin_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ptype` text NOT NULL,
	`v0` text,
	`v1` text,
	`v2` text,
	`v3` text,
	`v4` text,
	`v5` text
);
--> statement-breakpoint
CREATE INDEX `idx_casbin_rules_ptype` ON `casbin_rules` (`ptype`);--> statement-breakpoint
CREATE INDEX `idx_casbin_rules_v1` ON `casbin_rules` (`v1`);--> statement-breakpoint
CREATE TABLE `resource_group_items` (
	`group_id` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_ref` text NOT NULL,
	PRIMARY KEY(`group_id`, `resource_type`, `resource_ref`),
	FOREIGN KEY (`group_id`) REFERENCES `resource_groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `resource_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`identifier` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_resource_groups_ns` ON `resource_groups` (`namespace_id`,`identifier`);--> statement-breakpoint
CREATE TABLE `service_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`identifier` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`role` text DEFAULT 'developer' NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_service_accounts_ns` ON `service_accounts` (`namespace_id`,`identifier`);--> statement-breakpoint
CREATE TABLE `user_group_members` (
	`group_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`group_id`, `user_id`),
	FOREIGN KEY (`group_id`) REFERENCES `user_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_user_group_members_user` ON `user_group_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `user_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`identifier` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`role` text DEFAULT 'viewer' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_user_groups_ns` ON `user_groups` (`namespace_id`,`identifier`);--> statement-breakpoint
CREATE TABLE `scan_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`head_oid` text NOT NULL,
	`actor` text NOT NULL,
	`status` text NOT NULL,
	`tools` text NOT NULL,
	`duration_ms` integer,
	`ran_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_scan_runs_repo_head` ON `scan_runs` (`repository_id`,`head_oid`);--> statement-breakpoint
CREATE INDEX `idx_scan_runs_repo_ran` ON `scan_runs` (`repository_id`,`ran_at`);--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`name` text NOT NULL,
	`version` text NOT NULL,
	`path` text NOT NULL,
	`r2_key` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`content_type` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_artifacts_repo_nvp` ON `artifacts` (`repository_id`,`name`,`version`,`path`);--> statement-breakpoint
CREATE INDEX `idx_artifacts_repo_name` ON `artifacts` (`repository_id`,`name`);--> statement-breakpoint
CREATE TABLE `environments` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`identifier` text NOT NULL,
	`description` text,
	`type` text DEFAULT 'pre_production' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_environments_ns_ident` ON `environments` (`namespace_id`,`identifier`);--> statement-breakpoint
CREATE INDEX `idx_environments_ns` ON `environments` (`namespace_id`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`link` text,
	`created_at` integer NOT NULL,
	`read_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_notifications_user_created` ON `notifications` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_notifications_user_unread` ON `notifications` (`user_id`,`read_at`);--> statement-breakpoint
CREATE TABLE `connectors` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`identifier` text NOT NULL,
	`type` text NOT NULL,
	`sealed_handle` text,
	`endpoint` text,
	`description` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_connectors_ns_ident` ON `connectors` (`namespace_id`,`identifier`);--> statement-breakpoint
CREATE INDEX `idx_connectors_ns` ON `connectors` (`namespace_id`);--> statement-breakpoint
CREATE TABLE `delegate_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`identifier` text NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'offline' NOT NULL,
	`last_seen_at` integer,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_delegates_ns_ident` ON `delegate_agents` (`namespace_id`,`identifier`);--> statement-breakpoint
CREATE INDEX `idx_delegates_ns` ON `delegate_agents` (`namespace_id`);--> statement-breakpoint
CREATE TABLE `external_tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`repository_id` text,
	`external_id` text NOT NULL,
	`title` text NOT NULL,
	`url` text,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_tickets_ns` ON `external_tickets` (`namespace_id`);--> statement-breakpoint
CREATE INDEX `idx_tickets_repo` ON `external_tickets` (`repository_id`);--> statement-breakpoint
CREATE TABLE `feature_flags` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`identifier` text NOT NULL,
	`state` integer DEFAULT 0 NOT NULL,
	`targets` text DEFAULT '[]' NOT NULL,
	`description` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_flags_ns_ident` ON `feature_flags` (`namespace_id`,`identifier`);--> statement-breakpoint
CREATE INDEX `idx_flags_ns` ON `feature_flags` (`namespace_id`);--> statement-breakpoint
CREATE TABLE `file_store` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`name` text NOT NULL,
	`r2_key` text NOT NULL,
	`size` integer NOT NULL,
	`content_type` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_files_ns_name` ON `file_store` (`namespace_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_files_ns` ON `file_store` (`namespace_id`);--> statement-breakpoint
CREATE TABLE `freeze_windows` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`identifier` text NOT NULL,
	`schedule` text NOT NULL,
	`applies_to` text DEFAULT 'all' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_freeze_ns_ident` ON `freeze_windows` (`namespace_id`,`identifier`);--> statement-breakpoint
CREATE INDEX `idx_freeze_ns` ON `freeze_windows` (`namespace_id`);--> statement-breakpoint
CREATE TABLE `gitops_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`identifier` text NOT NULL,
	`repository_id` text NOT NULL,
	`branch` text DEFAULT 'main' NOT NULL,
	`target_environment` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`last_sync_at` integer,
	`last_sync_oid` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_gitops_ns_ident` ON `gitops_targets` (`namespace_id`,`identifier`);--> statement-breakpoint
CREATE INDEX `idx_gitops_repo` ON `gitops_targets` (`repository_id`);--> statement-breakpoint
CREATE TABLE `iac_states` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`name` text NOT NULL,
	`r2_key` text,
	`version` integer DEFAULT 0 NOT NULL,
	`lock_id` text,
	`lock_info` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_iac_ns_name` ON `iac_states` (`namespace_id`,`name`);--> statement-breakpoint
CREATE TABLE `overrides` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`subject` text NOT NULL,
	`reason` text NOT NULL,
	`created_by` text NOT NULL,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_overrides_ns` ON `overrides` (`namespace_id`);--> statement-breakpoint
CREATE TABLE `policies` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`identifier` text NOT NULL,
	`document` text NOT NULL,
	`applies_to` text DEFAULT 'all' NOT NULL,
	`enforcement` text DEFAULT 'warn' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_policies_ns_ident` ON `policies` (`namespace_id`,`identifier`);--> statement-breakpoint
CREATE INDEX `idx_policies_ns` ON `policies` (`namespace_id`);--> statement-breakpoint
CREATE TABLE `certificates` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`domain` text NOT NULL,
	`issuer` text,
	`expires_at` integer NOT NULL,
	`auto_renew` integer DEFAULT 0 NOT NULL,
	`last_probed_at` integer,
	`last_notified_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_certs_ns_domain` ON `certificates` (`namespace_id`,`domain`);--> statement-breakpoint
CREATE INDEX `idx_certs_expiry` ON `certificates` (`expires_at`);--> statement-breakpoint
CREATE TABLE `chaos_experiments` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`identifier` text NOT NULL,
	`repository_id` text,
	`kind` text NOT NULL,
	`spec` text DEFAULT '{}' NOT NULL,
	`last_run_at` integer,
	`last_outcome` text,
	`last_report` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_chaos_ns_ident` ON `chaos_experiments` (`namespace_id`,`identifier`);--> statement-breakpoint
CREATE INDEX `idx_chaos_ns` ON `chaos_experiments` (`namespace_id`);--> statement-breakpoint
CREATE TABLE `cost_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`provider` text NOT NULL,
	`service` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`period_start` integer NOT NULL,
	`period_end` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_costs_ns` ON `cost_snapshots` (`namespace_id`,`period_start`);--> statement-breakpoint
CREATE TABLE `downtimes` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`monitor_id` text,
	`reason` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_downtimes_ns` ON `downtimes` (`namespace_id`);--> statement-breakpoint
CREATE TABLE `incident_updates` (
	`id` text PRIMARY KEY NOT NULL,
	`incident_id` text NOT NULL,
	`body` text NOT NULL,
	`status` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`incident_id`) REFERENCES `incidents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_iupdates_incident` ON `incident_updates` (`incident_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`title` text NOT NULL,
	`severity` text DEFAULT 'sev3' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`summary` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_incidents_ns` ON `incidents` (`namespace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `monitor_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`monitor_id` text NOT NULL,
	`status` text NOT NULL,
	`latency_ms` integer,
	`status_code` integer,
	`checked_at` integer NOT NULL,
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_mchecks_monitor` ON `monitor_checks` (`monitor_id`,`checked_at`);--> statement-breakpoint
CREATE TABLE `monitors` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`identifier` text NOT NULL,
	`url` text NOT NULL,
	`method` text DEFAULT 'GET' NOT NULL,
	`expected_status` integer DEFAULT 200 NOT NULL,
	`interval_sec` integer DEFAULT 300 NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`last_status` text,
	`last_latency_ms` integer,
	`last_checked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_monitors_ns_ident` ON `monitors` (`namespace_id`,`identifier`);--> statement-breakpoint
CREATE INDEX `idx_monitors_ns` ON `monitors` (`namespace_id`);--> statement-breakpoint
CREATE TABLE `slos` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`identifier` text NOT NULL,
	`monitor_id` text,
	`target_pct` integer NOT NULL,
	`window_days` integer DEFAULT 30 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_slos_ns_ident` ON `slos` (`namespace_id`,`identifier`);--> statement-breakpoint
CREATE INDEX `idx_slos_ns` ON `slos` (`namespace_id`);--> statement-breakpoint
CREATE TABLE `catalog_entities` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`identifier` text NOT NULL,
	`kind` text DEFAULT 'service' NOT NULL,
	`repository_id` text,
	`owner` text,
	`description` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_catalog_ns_ident` ON `catalog_entities` (`namespace_id`,`identifier`);--> statement-breakpoint
CREATE INDEX `idx_catalog_ns` ON `catalog_entities` (`namespace_id`);--> statement-breakpoint
CREATE TABLE `dashboards` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`identifier` text NOT NULL,
	`layout` text DEFAULT '[]' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_dash_ns_ident` ON `dashboards` (`namespace_id`,`identifier`);--> statement-breakpoint
CREATE INDEX `idx_dash_ns` ON `dashboards` (`namespace_id`);--> statement-breakpoint
CREATE TABLE `database_records` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`identifier` text NOT NULL,
	`engine` text DEFAULT 'postgres' NOT NULL,
	`host` text,
	`status` text DEFAULT 'provisioned' NOT NULL,
	`migrations` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_dbrec_ns_ident` ON `database_records` (`namespace_id`,`identifier`);--> statement-breakpoint
CREATE INDEX `idx_dbrec_ns` ON `database_records` (`namespace_id`);--> statement-breakpoint
CREATE TABLE `dev_environments` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`identifier` text NOT NULL,
	`repository_id` text,
	`status` text DEFAULT 'stopped' NOT NULL,
	`machine_type` text DEFAULT 'standard' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_devenv_ns_ident` ON `dev_environments` (`namespace_id`,`identifier`);--> statement-breakpoint
CREATE INDEX `idx_devenv_ns` ON `dev_environments` (`namespace_id`);--> statement-breakpoint
CREATE TABLE `security_tests` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`repository_id` text,
	`kind` text NOT NULL,
	`target` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`findings` integer DEFAULT 0 NOT NULL,
	`report` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_sectests_ns` ON `security_tests` (`namespace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_sectests_repo` ON `security_tests` (`repository_id`);--> statement-breakpoint
CREATE TABLE `supply_chain_docs` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`kind` text NOT NULL,
	`commit_oid` text,
	`document` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_supply_ns` ON `supply_chain_docs` (`namespace_id`);--> statement-breakpoint
CREATE INDEX `idx_supply_repo` ON `supply_chain_docs` (`repository_id`);--> statement-breakpoint
CREATE TABLE `follows` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`namespace_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_follows_user_namespace` ON `follows` (`user_id`,`namespace_id`);--> statement-breakpoint
CREATE INDEX `idx_follows_namespace` ON `follows` (`namespace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `repo_topics` (
	`repository_id` text NOT NULL,
	`topic` text NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_repo_topics_topic" CHECK("topic" GLOB '[a-z0-9][a-z0-9-]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_repo_topics_repo_topic` ON `repo_topics` (`repository_id`,`topic`);--> statement-breakpoint
CREATE INDEX `idx_repo_topics_topic` ON `repo_topics` (`topic`,`repository_id`);--> statement-breakpoint
CREATE TABLE `repo_watchers` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_watchers_user_repo` ON `repo_watchers` (`user_id`,`repository_id`);--> statement-breakpoint
CREATE INDEX `idx_watchers_repo` ON `repo_watchers` (`repository_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `stars` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_stars_user_repo` ON `stars` (`user_id`,`repository_id`);--> statement-breakpoint
CREATE INDEX `idx_stars_repo` ON `stars` (`repository_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `security_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`detail` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_security_events_user` ON `security_events` (`user_id`,"created_at" desc);--> statement-breakpoint
CREATE TABLE `passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text,
	`name` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_passkeys_user` ON `passkeys` (`user_id`,"created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_passkeys_credential` ON `passkeys` (`credential_id`);--> statement-breakpoint
CREATE TABLE `eval_corpus` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`intent_id` text,
	`engine` text NOT NULL,
	`input` text NOT NULL,
	`output` text,
	`outcome` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_eval_corpus_repo` ON `eval_corpus` (`repository_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_eval_corpus_intent` ON `eval_corpus` (`intent_id`);