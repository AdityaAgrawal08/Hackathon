DROP INDEX `uq_one_open_per_customer`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_one_open_per_customer` ON `proposals` (`customer_id`) WHERE 
      state IN ('PROPOSED','AWAITING_APPROVAL','AUTO_APPROVED','APPROVED','EXECUTING')
    ;