import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { getVersion, getWorkspace } from '@/db/repository';
import { assertPermission } from '@/lib/rbac';
import { buildConfigZip } from '@/lib/config-export';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ versionId: string }> },
) {
  try {
    const user = await getCurrentUser();
    const workspace = await getWorkspace(user);
    assertPermission(workspace.access.role, 'configs:view', workspace.access.extraPermissions);
    const { versionId } = await params;
    const version = await getVersion(versionId);
    const archive = buildConfigZip(version.configs, {
      game: workspace.game.name,
      versionId: version.id,
      baseSha: version.baseSha,
      contentHash: version.contentHash,
      createdAt: new Date(version.createdAt).toISOString(),
      source: version.source,
    });
    return new NextResponse(archive, {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="dig-get-stronger-${version.id}.zip"`,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Экспорт не выполнен.' }, {
      status: 400,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
