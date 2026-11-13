// Where the API is. This is the only file that differs between deployments.
//
//   apiBase          '' means "the server that served this page" (the container: page at /,
//                    API at /api). Otherwise the address of a separately hosted API, scheme and
//                    host included, without a trailing slash and without "/api".
//   apiAlternatives  other API addresses that the URL parameter ?api=... may select. A parameter
//                    naming anything that is not listed here (or apiBase) is ignored, so a link
//                    can never point the page at somebody else's server.
//   demoOnly         true when there is no API at all: the page then always shows the
//                    demonstration with saved results.
//
// scripts/build_pages.sh overwrites this file for the GitHub Pages build and adds the same
// addresses to the Content-Security-Policy in index.html.
export default {
  apiBase: '',
  apiAlternatives: [],
  demoOnly: false,
};
