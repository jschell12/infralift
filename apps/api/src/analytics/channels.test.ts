import { describe, expect, it } from "vitest";
import { channelFor } from "./channels.js";

describe("channelFor", () => {
  it("returns direct when there is no referrer and no utm_source", () => {
    expect(channelFor("", "")).toBe("direct");
  });

  it("prefers utm_source over the referrer host", () => {
    expect(channelFor("www.google.com", "newsletter-aug")).toBe("email");
  });

  it("maps utm_source aliases", () => {
    expect(channelFor("", "hn")).toBe("hn");
    expect(channelFor("", "hackernews")).toBe("hn");
    expect(channelFor("", "reddit-selfhosted")).toBe("reddit");
    expect(channelFor("", "lobsters")).toBe("lobsters");
    expect(channelFor("", "x")).toBe("x");
    expect(channelFor("", "Twitter")).toBe("x");
    expect(channelFor("", "email")).toBe("email");
  });

  it("passes through unknown utm_source values lowercased", () => {
    expect(channelFor("", "Some-Podcast")).toBe("some-podcast");
  });

  it("maps referrer hosts", () => {
    expect(channelFor("news.ycombinator.com", "")).toBe("hn");
    expect(channelFor("www.reddit.com", "")).toBe("reddit");
    expect(channelFor("old.reddit.com", "")).toBe("reddit");
    expect(channelFor("lobste.rs", "")).toBe("lobsters");
    expect(channelFor("t.co", "")).toBe("x");
    expect(channelFor("x.com", "")).toBe("x");
    expect(channelFor("twitter.com", "")).toBe("x");
    expect(channelFor("www.google.com", "")).toBe("google");
    expect(channelFor("google.co.uk", "")).toBe("google");
    expect(channelFor("www.bing.com", "")).toBe("search");
    expect(channelFor("duckduckgo.com", "")).toBe("search");
    expect(channelFor("github.com", "")).toBe("github");
    expect(channelFor("www.linkedin.com", "")).toBe("linkedin");
    expect(channelFor("m.facebook.com", "")).toBe("facebook");
  });

  it("buckets unknown referrers as other", () => {
    expect(channelFor("example.com", "")).toBe("other");
  });

  it("is case-insensitive on hosts", () => {
    expect(channelFor("News.Ycombinator.Com", "")).toBe("hn");
  });
});
