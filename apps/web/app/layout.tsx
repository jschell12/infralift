import type { Metadata } from "next";
import { listProviders } from "../lib/providers";
import "./globals.css";

const TITLE = "infralift | bring click-ops infrastructure under Terraform";
const DESCRIPTION = `Find the cloud resources nobody wrote Terraform for, adopt them through a pull request that has to plan zero changes, then manage them as code with plan-on-PR, apply-on-merge and daily drift checks. Free assessment for ${listProviders()}.`;

// The provider list comes from lib/providers.ts, so this description and the
// home page count cannot disagree again (they said 11 and 12).
export const metadata: Metadata = {
  metadataBase: new URL("https://infralift.dev"),
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    type: "website",
    siteName: "infralift",
    title: TITLE,
    description: DESCRIPTION,
  },
  twitter: { card: "summary", title: TITLE, description: DESCRIPTION },
};

// First-party page-view beacon. Posts {p: path, r: referrer, q: query} to
// the same-origin /a/e endpoint handled by the Worker in ../worker/index.ts.
// Inline (no client component) so it works with the static export. Tracks
// SPA navigations by wrapping history.pushState/replaceState.
const BEACON = `(function(){
if(navigator.webdriver)return;
var last="";
function send(){
var p=location.pathname;
if(p===last)return;
last=p;
try{
var d=JSON.stringify({p:p,r:document.referrer||"",q:location.search||""});
if(!(navigator.sendBeacon&&navigator.sendBeacon("/a/e",d)))
fetch("/a/e",{method:"POST",body:d,keepalive:true}).catch(function(){});
}catch(e){}
}
var h=history,ps=h.pushState,rs=h.replaceState;
h.pushState=function(){ps.apply(h,arguments);setTimeout(send,0);};
h.replaceState=function(){rs.apply(h,arguments);setTimeout(send,0);};
addEventListener("popstate",function(){setTimeout(send,0);});
addEventListener("pageshow",function(e){if(e.persisted){last="";send();}});
send();
})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        {children}
        <script dangerouslySetInnerHTML={{ __html: BEACON }} />
      </body>
    </html>
  );
}
