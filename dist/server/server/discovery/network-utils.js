import net from 'node:net';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
export async function findAvailablePort(preferredPort = 3800, host = '0.0.0.0', maxAttempts = 20) {
    for (let i = 0; i < maxAttempts; i++) {
        const candidate = preferredPort + i;
        const available = await new Promise((resolve) => {
            const tester = net.createServer();
            tester.unref();
            tester.once('error', () => {
                resolve(false);
            });
            tester.listen({ port: candidate, host, exclusive: true }, () => {
                tester.close(() => resolve(true));
            });
        });
        if (available) {
            return candidate;
        }
    }
    throw new Error(`Could not find an available TCP port between ${preferredPort} and ${preferredPort + maxAttempts - 1}`);
}
// Known Hikvision & Ezviz IEEE OUI prefixes (lowercase colon-formatted)
const EZVIZ_HIKVISION_OUIS = new Set([
    'c0:56:e3',
    '44:19:b6',
    'bc:ad:28',
    '28:57:be',
    'a4:14:37',
    'e0:50:8b',
    '4c:bd:8f',
    '54:c4:15',
    '64:db:8b',
    '80:7c:62',
    '8c:e7:48',
    '98:8b:0a',
    'ac:b9:2f',
    'c4:2f:90',
    'd4:e8:53',
    'ec:a9:71',
    'f8:4d:fc',
]);
const VIRTUAL_NIC_PATTERNS = /wsl|hyper-v|vethernet|docker|vmware|virtualbox|vbox|loopback|tailscale|zerotier/i;
function isPrivateIpv4(ip) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n)))
        return false;
    if (parts[0] === 10)
        return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
        return true;
    if (parts[0] === 192 && parts[1] === 168)
        return true;
    return false;
}
export function getHostLanIps(interfaces = os.networkInterfaces()) {
    const ips = [];
    for (const [name, list] of Object.entries(interfaces)) {
        if (!list || VIRTUAL_NIC_PATTERNS.test(name))
            continue;
        for (const info of list) {
            if (info.family !== 'IPv4' || info.internal)
                continue;
            if (info.address.startsWith('169.254.'))
                continue;
            if (isPrivateIpv4(info.address)) {
                ips.push(info.address);
            }
        }
    }
    return ips;
}
export function getLocalScanTargets(interfaces = os.networkInterfaces()) {
    const targets = new Set();
    const hostIps = new Set();
    for (const [name, list] of Object.entries(interfaces)) {
        if (!list || VIRTUAL_NIC_PATTERNS.test(name))
            continue;
        for (const info of list) {
            if (info.family !== 'IPv4' || info.internal)
                continue;
            if (!isPrivateIpv4(info.address))
                continue;
            hostIps.add(info.address);
            const octets = info.address.split('.');
            // Always cap scan range to the /24 block surrounding the host IP
            const prefix = `${octets[0]}.${octets[1]}.${octets[2]}`;
            for (let host = 1; host <= 254; host++) {
                targets.add(`${prefix}.${host}`);
            }
        }
    }
    for (const selfIp of hostIps) {
        targets.delete(selfIp);
    }
    return Array.from(targets);
}
export function parseArpTable(arpOutput) {
    const result = new Map();
    const lineRegex = /(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-fA-F]{2}(?:[:-][0-9a-fA-F]{2}){5})/g;
    let match;
    while ((match = lineRegex.exec(arpOutput)) !== null) {
        const ip = match[1];
        const mac = match[2].toLowerCase().replace(/-/g, ':');
        if (mac === 'ff:ff:ff:ff:ff:ff' || mac === '00:00:00:00:00:00')
            continue;
        const oui = mac.slice(0, 8);
        const brandHint = EZVIZ_HIKVISION_OUIS.has(oui) ? 'ezviz' : 'generic';
        result.set(ip, { mac, brandHint });
    }
    return result;
}
export async function readSystemArpTable() {
    try {
        const { stdout } = await execFileAsync('arp', ['-a'], { timeout: 3000 });
        return parseArpTable(stdout);
    }
    catch {
        return new Map();
    }
}
