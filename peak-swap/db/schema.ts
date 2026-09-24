import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
export const orders = sqliteTable('swap_orders', {
 id:text('id').primaryKey(), /** Recent blockhash the quoted transaction was built with. */ requestId:text('request_id').notNull(), wallet:text('wallet').notNull(), message:text('message').notNull(), quote:text('quote').notNull(), source:text('source'), createdAt:integer('created_at').notNull(), expiresAt:integer('expires_at').notNull(), status:text('status').notNull().default('quoted'), signedHash:text('signed_hash'), executingAt:integer('executing_at'), result:text('result'), signature:text('signature'), lastValidBlockHeight:integer('last_valid_block_height'),
},t=>[index('orders_created').on(t.createdAt)]);
export const limits = sqliteTable('rate_limits',{key:text('key').primaryKey(),count:integer('count').notNull(),expiresAt:integer('expires_at').notNull()},t=>[index('limits_expiry').on(t.expiresAt)]);
