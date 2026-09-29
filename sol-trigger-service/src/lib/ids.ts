import { randomBytes } from 'node:crypto';

export const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString('base64url')}`;
