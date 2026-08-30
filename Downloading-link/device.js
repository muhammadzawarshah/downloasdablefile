// Minimal user-agent parsing — enough to say "Chrome 127 on Windows, desktop"
// without pulling in a dependency.

function browserOf(ua) {
  const tests = [
    [/Edg(?:e|A|iOS)?\/([\d.]+)/, "Edge"],
    [/OPR\/([\d.]+)/, "Opera"],
    [/SamsungBrowser\/([\d.]+)/, "Samsung Internet"],
    [/Firefox\/([\d.]+)/, "Firefox"],
    [/CriOS\/([\d.]+)/, "Chrome"],
    [/Chrome\/([\d.]+)/, "Chrome"],
    [/Version\/([\d.]+).*Safari/, "Safari"],
    [/curl\/([\d.]+)/, "curl"],
    [/wget\/([\d.]+)/i, "Wget"]
  ];
  for (const [re, name] of tests) {
    const m = re.exec(ua);
    if (m) return `${name} ${m[1].split(".")[0]}`;
  }
  return "Unknown browser";
}

function osOf(ua) {
  let m;
  if ((m = /Windows NT ([\d.]+)/.exec(ua))) {
    const map = { "10.0": "10/11", "6.3": "8.1", "6.2": "8", "6.1": "7" };
    return `Windows ${map[m[1]] || m[1]}`;
  }
  if ((m = /Android ([\d.]+)/.exec(ua))) return `Android ${m[1]}`;
  if ((m = /(?:iPhone|CPU) OS ([\d_]+)/.exec(ua))) return `iOS ${m[1].replace(/_/g, ".")}`;
  if ((m = /Mac OS X ([\d_.]+)/.exec(ua))) return `macOS ${m[1].replace(/_/g, ".")}`;
  if (/CrOS/.test(ua)) return "ChromeOS";
  if (/Linux/.test(ua)) return "Linux";
  return "Unknown OS";
}

function deviceOf(ua) {
  if (/iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/.test(ua)) return "tablet";
  if (/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone/.test(ua)) return "mobile";
  if (/bot|crawler|spider|curl|wget|preview|facebookexternalhit|WhatsApp|Slackbot|Telegram/i.test(ua)) return "bot";
  return "desktop";
}

function parse(ua) {
  const agent = ua || "";
  return { browser: browserOf(agent), os: osOf(agent), device: deviceOf(agent) };
}

module.exports = { parse };
