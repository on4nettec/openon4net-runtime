import type { FastifyInstance } from 'fastify';
import { NotFoundError, ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { requirePermission } from '../lib/require-permission.js';
import { requireAgentAccessible } from '../lib/agent-access.js';
import { AgentService } from '../services/agent-service.js';
import { WorkspaceFileService } from '../services/workspace-file-service.js';
import { AuditService } from '../services/audit-service.js';
import { deleteFile, getPresignedDownloadUrl, isObjectStorageConfigured, uploadFile } from '../lib/object-storage.js';

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB — a workspace file, not a video

/**
 * RT-025 — files attached to an Agent's own (RT-023: dedicated 1:1)
 * workspace. Routes are agent-scoped, not workspace-scoped, specifically so
 * they can reuse requireAgentAccessible — the same access check already
 * gating chat/tools for a given agent — rather than inventing a separate
 * workspace-membership concept. Files themselves are always private
 * (object-storage.ts's default): a presigned URL is generated fresh on
 * every list/get call, never cached.
 */
export function registerAgentFileRoutes(app: FastifyInstance, ctx: AppContext): void {
  const agentService = new AgentService(ctx.db);
  const fileService = new WorkspaceFileService(ctx.db);

  app.post<{ Params: { agentId: string } }>('/v1/agents/:agentId/files', async (request) => {
    requirePermission(request, 'agents:update');
    await requireAgentAccessible(ctx, request, request.params.agentId);
    if (!isObjectStorageConfigured(ctx.env)) {
      throw new ValidationError('Object storage is not configured (MINIO_ENDPOINT/MINIO_ROOT_USER/MINIO_ROOT_PASSWORD unset)');
    }

    const agent = await agentService.getById(request.auth.organizationId, request.params.agentId);
    const file = await request.file({ limits: { fileSize: MAX_FILE_SIZE } });
    if (!file) throw new ValidationError('No file uploaded — send a multipart/form-data request with a "file" field');

    const buffer = await file.toBuffer();
    const storageKey = `workspaces/${agent.workspaceId}/${Date.now()}-${file.filename}`;
    await uploadFile(ctx.env, storageKey, buffer, file.mimetype);

    const record = await fileService.create({
      workspaceId: agent.workspaceId,
      organizationId: request.auth.organizationId,
      filename: file.filename,
      storageKey,
      contentType: file.mimetype,
      sizeBytes: buffer.length,
      uploadedByUserId: request.auth.userId,
    });

    await new AuditService(ctx.db).logAction({
      organizationId: request.auth.organizationId,
      agentId: agent.id,
      userId: request.auth.userId,
      actionType: 'agent-file-upload',
      actionData: { traceId: request.traceId, filename: file.filename, fileId: record.id, sizeBytes: record.sizeBytes },
    });

    return record;
  });

  app.get<{ Params: { agentId: string } }>('/v1/agents/:agentId/files', async (request) => {
    requirePermission(request, 'agents:read');
    await requireAgentAccessible(ctx, request, request.params.agentId);
    const agent = await agentService.getById(request.auth.organizationId, request.params.agentId);
    return fileService.listByWorkspace(agent.workspaceId);
  });

  app.get<{ Params: { agentId: string; fileId: string } }>(
    '/v1/agents/:agentId/files/:fileId/download',
    async (request) => {
      requirePermission(request, 'agents:read');
      await requireAgentAccessible(ctx, request, request.params.agentId);
      const file = await fileService.getById(request.auth.organizationId, request.params.fileId);
      if (!file) throw new NotFoundError('File', request.params.fileId);
      const url = await getPresignedDownloadUrl(ctx.env, file.storageKey);
      return { url };
    },
  );

  app.delete<{ Params: { agentId: string; fileId: string } }>('/v1/agents/:agentId/files/:fileId', async (request, reply) => {
    requirePermission(request, 'agents:update');
    await requireAgentAccessible(ctx, request, request.params.agentId);
    const file = await fileService.delete(request.auth.organizationId, request.params.fileId);
    if (!file) throw new NotFoundError('File', request.params.fileId);

    await deleteFile(ctx.env, file.storageKey);
    await new AuditService(ctx.db).logAction({
      organizationId: request.auth.organizationId,
      agentId: request.params.agentId,
      userId: request.auth.userId,
      actionType: 'agent-file-delete',
      actionData: { traceId: request.traceId, filename: file.filename, fileId: file.id },
    });
    return reply.status(204).send();
  });
}
