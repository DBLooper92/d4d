// src/app/api/ghl/location-users/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { ghlLocationGetJson } from '@/lib/ghlTokens';

export const dynamic = 'force-dynamic';

type GhlUser = {
  id: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  email?: string;
};
type UsersResp = { users: GhlUser[] };

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const locationId = searchParams.get('location_id');
    if (!locationId) {
      return NextResponse.json({ error: 'Missing location_id' }, { status: 400 });
    }

    const companyId = searchParams.get('company_id') ?? undefined;
    const url = `https://services.leadconnectorhq.com/users/?locationId=${encodeURIComponent(locationId)}`;

    const data = await ghlLocationGetJson<UsersResp>(locationId, url, companyId);
    return NextResponse.json(data, { status: 200 });
  } catch (err: unknown) {
    const message =
      typeof err === 'object' && err !== null && 'toString' in err
        ? String(err)
        : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
