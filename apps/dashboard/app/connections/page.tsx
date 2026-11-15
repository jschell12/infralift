import { redirect } from "next/navigation";
import { legacyAddConnectionUrl } from "../../lib/connections";
import ConnectionsView from "./connections-view";

// Old links opened the add form here: /connections?provider=heroku. Adding is
// its own page now. Redirecting on the server sends them there with the same
// type before the list renders; an unknown provider stays on the list.
export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const provider = (await searchParams).provider;
  const target = legacyAddConnectionUrl(new URLSearchParams(typeof provider === "string" ? { provider } : {}).toString());
  if (target) redirect(target);
  return <ConnectionsView />;
}
