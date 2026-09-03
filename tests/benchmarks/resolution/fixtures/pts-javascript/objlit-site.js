// #2088: allocation-site correlation for a handler-array declared inside the consumer.
function isFooSite(x) {
  return x === 1;
}
function doFooSite(x) {
  return x;
}
function pickSite(x) {
  const RESOLVERS_SITE = [{ matches: isFooSite, resolve: doFooSite }];
  for (const r of RESOLVERS_SITE) if (r.matches(x)) return r.resolve(x);
}
