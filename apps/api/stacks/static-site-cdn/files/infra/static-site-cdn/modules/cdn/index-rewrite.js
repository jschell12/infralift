// CloudFront Function (viewer request). S3 behind origin access control has
// no index documents, so /docs/ and /docs would otherwise be 403s: both are
// rewritten to /docs/index.html. Paths with a file extension pass unchanged.
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.endsWith("/")) {
    request.uri = uri + "index.html";
  } else if (uri.lastIndexOf(".") <= uri.lastIndexOf("/")) {
    request.uri = uri + "/index.html";
  }
  return request;
}
