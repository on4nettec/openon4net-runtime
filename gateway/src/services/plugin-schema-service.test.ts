import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../test-support/db.js';
import { PluginSchemaService } from './plugin-schema-service.js';

describe('PluginSchemaService (RT-076)', () => {
  const db = createTestDb();
  const createdSchemas: string[] = [];

  afterEach(async () => {
    for (const schema of createdSchemas.splice(0)) {
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  });

  afterAll(async () => {
    await db.end();
  });

  it('provisions an isolated schema per (organizationId, pluginId) pair, not a shared table', async () => {
    const service = new PluginSchemaService(db);
    const orgId = randomUUID();
    const pluginId = randomUUID();

    const schema = await service.ensureSchema(orgId, pluginId);
    createdSchemas.push(schema);

    const { rows } = await db.query<{ schema_name: string }>(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1`,
      [schema],
    );
    expect(rows).toHaveLength(1);

    const tableCheck = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'kv'`,
      [schema],
    );
    expect(tableCheck.rows).toHaveLength(1);
  });

  it('writes and reads back state, round-tripping arbitrary JSON values', async () => {
    const service = new PluginSchemaService(db);
    const orgId = randomUUID();
    const pluginId = randomUUID();
    createdSchemas.push(service.schemaName(orgId, pluginId));

    await service.writeAll(orgId, pluginId, { counter: 3, nested: { a: [1, 2, 3] } });
    const state = await service.readAll(orgId, pluginId);
    expect(state).toEqual({ counter: 3, nested: { a: [1, 2, 3] } });
  });

  it('upserts on repeated writes to the same key instead of erroring', async () => {
    const service = new PluginSchemaService(db);
    const orgId = randomUUID();
    const pluginId = randomUUID();
    createdSchemas.push(service.schemaName(orgId, pluginId));

    await service.writeAll(orgId, pluginId, { counter: 1 });
    await service.writeAll(orgId, pluginId, { counter: 2 });
    const state = await service.readAll(orgId, pluginId);
    expect(state).toEqual({ counter: 2 });
  });

  it('keeps state fully isolated between different plugins, and between different organizations for the same plugin', async () => {
    const service = new PluginSchemaService(db);
    const orgA = randomUUID();
    const orgB = randomUUID();
    const pluginX = randomUUID();
    const pluginY = randomUUID();
    createdSchemas.push(service.schemaName(orgA, pluginX));
    createdSchemas.push(service.schemaName(orgB, pluginX));
    createdSchemas.push(service.schemaName(orgA, pluginY));

    await service.writeAll(orgA, pluginX, { value: 'org-a-plugin-x' });
    await service.writeAll(orgB, pluginX, { value: 'org-b-plugin-x' });
    await service.writeAll(orgA, pluginY, { value: 'org-a-plugin-y' });

    expect(await service.readAll(orgA, pluginX)).toEqual({ value: 'org-a-plugin-x' });
    expect(await service.readAll(orgB, pluginX)).toEqual({ value: 'org-b-plugin-x' });
    expect(await service.readAll(orgA, pluginY)).toEqual({ value: 'org-a-plugin-y' });
  });

  it('returns an empty object for a (organizationId, pluginId) pair that has never written anything', async () => {
    const service = new PluginSchemaService(db);
    const orgId = randomUUID();
    const pluginId = randomUUID();
    createdSchemas.push(service.schemaName(orgId, pluginId));

    expect(await service.readAll(orgId, pluginId)).toEqual({});
  });
});
