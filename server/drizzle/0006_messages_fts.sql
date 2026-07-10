CREATE VIRTUAL TABLE `messages_fts` USING fts5(content, content='messages', content_rowid='id');--> statement-breakpoint
CREATE TRIGGER `messages_fts_ai` AFTER INSERT ON `messages` BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;--> statement-breakpoint
CREATE TRIGGER `messages_fts_ad` AFTER DELETE ON `messages` BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
END;--> statement-breakpoint
CREATE TRIGGER `messages_fts_au` AFTER UPDATE ON `messages` BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;--> statement-breakpoint
INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
