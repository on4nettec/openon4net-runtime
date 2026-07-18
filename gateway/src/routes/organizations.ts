import type { FastifyInstance } from 'fastify';
import { OrganizationUpdateSchema } from '@o2n/shared';
import { ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { requirePermission } from '../lib/require-permission.js';
import { OrgService } from '../services/org-service.js';
import { isObjectStorageConfigured, uploadFile } from '../lib/object-storage.js';
import { AuditService } from '../services/audit-service.js';

const ALLOWED_LOGO_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp']);

/** No :id in these routes — a session belongs to exactly one organization (request.auth.organizationId). */
export function registerOrganizationRoutes(app: FastifyInstance, ctx: AppContext): void {
  const orgService = new OrgService(ctx.db);

  app.get('/v1/organization', async (request) => {
    requirePermission(request, 'organization:read');
    return orgService.getById(request.auth.organizationId);
  });

  app.patch('/v1/organization', async (request) => {
    requirePermission(request, 'organization:write');
    const parsed = OrganizationUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid organization payload', parsed.error.flatten());

    return orgService.update(request.auth.organizationId, parsed.data);
  });

  // RT-030 — multipart upload, one logo variant (light/dark) per call.
  app.post('/v1/organization/branding', async (request) => {
    requirePermission(request, 'branding:update');
    if (!isObjectStorageConfigured(ctx.env)) {
      throw new ValidationError('Object storage is not configured (MINIO_ENDPOINT/MINIO_ROOT_USER/MINIO_ROOT_PASSWORD unset)');
    }

    const file = await request.file();
    if (!file) throw new ValidationError('No file uploaded — send a multipart/form-data request with a "logo" field');
    if (!ALLOWED_LOGO_MIME_TYPES.has(file.mimetype)) {
      throw new ValidationError(`Unsupported image type "${file.mimetype}" — use PNG, JPEG, SVG, or WebP`);
    }

    const variantField = file.fields.variant;
    const variant = variantField && 'value' in variantField ? variantField.value : 'light';
    if (variant !== 'light' && variant !== 'dark') {
      throw new ValidationError('variant field must be "light" or "dark"');
    }

    const buffer = await file.toBuffer();
    const extension = file.mimetype.split('/')[1] === 'svg+xml' ? 'svg' : file.mimetype.split('/')[1];
    const key = `branding/${request.auth.organizationId}/logo-${variant}.${extension}`;
    const uploaded = await uploadFile(ctx.env, key, buffer, file.mimetype, { public: true });

    const org = await orgService.updateBranding(
      request.auth.organizationId,
      variant === 'light' ? { logoLightUrl: uploaded.url } : { logoDarkUrl: uploaded.url },
    );

    await new AuditService(ctx.db).logAction({
      organizationId: request.auth.organizationId,
      userId: request.auth.userId,
      actionType: 'organization-branding-update',
      actionData: { traceId: request.traceId, variant, url: uploaded.url },
    });

    return org;
  });
}
