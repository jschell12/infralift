import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "infralift | fixed-fee infrastructure migrations, delivered as Terraform",
  description:
    "Your cloud bill shouldn't scale faster than your revenue. Free assessment for Vercel, Heroku, Firebase, AWS, GCP, Azure, Netlify, Render, Railway, Fly.io, and DigitalOcean. Fixed-fee migration onto infrastructure you own, delivered as Terraform.",
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
