import { handleWorkbookRequest } from "../../../server/workbook-runtime.ts";
import { withBrowserSession } from "../../../server/browser-session.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handle = async (request: Request) => {
  const authenticated = withBrowserSession(request);
  const response = authenticated instanceof Response ? authenticated : await handleWorkbookRequest(authenticated);
  response.headers.set("Vary", "Authorization, Cookie");
  return response;
};
export const GET = handle;
export const POST = handle;
