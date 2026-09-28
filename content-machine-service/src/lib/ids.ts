import { randomBytes, randomUUID } from 'node:crypto';

export const uid = () => randomUUID();

export const newApiKey = () => 'pk_' + randomBytes(32).toString('hex');
