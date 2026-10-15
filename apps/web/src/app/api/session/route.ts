import { createSessionHandler } from "../../../server/browser-session.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handle = (request: Request) => createSessionHandler(process.env)(request);
export const GET = handle;
export const POST = handle;
export const DELETE = handle;
