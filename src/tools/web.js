'use strict';

const https = require('https');
const dns = require('dns');
const { isPrivateHost } = require('../security');

function fetchUrl(url, hops = 0) {
  return new Promise((resolve, reject) => {
    if (!/^https:\/\//.test(url)) return reject(new Error('Only https:// URLs are allowed'));
    let host;
    try {
      host = new URL(url).hostname;
    } catch {
      return reject(new Error('Invalid URL'));
    }
    if (isPrivateHost(host)) return reject(new Error('Blocked: private/loopback addresses are not allowed'));
    if (hops > 5) return reject(new Error('Too many redirects (limit 5)'));

    const doFetch = () => {
      https
        .get(url, { headers: { 'User-Agent': 'easy-mcp' }, timeout: 20000 }, (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            res.resume();
            return resolve(fetchUrl(new URL(res.headers.location, url).toString(), hops + 1));
          }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (d) => {
            body += d;
            if (body.length > 300000) res.destroy();
          });
          res.on('end', () => resolve(body.slice(0, 300000)));
        })
        .on('error', reject);
    };

    dns.promises
      .lookup(host, { all: true })
      .then((addrs) => {
        if (addrs.some((a) => isPrivateHost(a.address))) {
          return reject(new Error('Blocked: host resolves to a private/loopback address'));
        }
        doFetch();
      })
      .catch(() => doFetch());
  });
}

function stripHtmlTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function createWebTools() {
  return [
    {
      name: 'fetch_url',
      description: 'Fetch a public https URL (documentation, API reference) and return its text.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          strip_html: { type: 'boolean', description: 'Strip HTML tags for cleaner text output' },
        },
        required: ['url'],
      },
      readOnly: true,
      openWorld: true,
      run: async ({ url, strip_html = false }) => {
        const text = await fetchUrl(url);
        return strip_html ? stripHtmlTags(text) : text;
      },
    },
  ];
}

module.exports = { createWebTools, fetchUrl };
