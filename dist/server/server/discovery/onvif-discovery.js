import dgram from 'node:dgram';
import crypto from 'node:crypto';
export function parseWsDiscoveryResponse(xml, fallbackIp) {
    if (!xml.includes('ProbeMatch'))
        return null;
    const xaddrsMatch = xml.match(/<(?:\w+:)?XAddrs>([^<]+)<\/(?:\w+:)?XAddrs>/i);
    const scopesMatch = xml.match(/<(?:\w+:)?Scopes>([^<]+)<\/(?:\w+:)?Scopes>/i);
    const rawXAddr = xaddrsMatch?.[1]?.trim().split(/\s+/)[0] ?? '';
    if (!rawXAddr)
        return null;
    let ipAddress = fallbackIp;
    try {
        const parsed = new URL(rawXAddr);
        if (parsed.hostname)
            ipAddress = parsed.hostname;
    }
    catch {
        // keep fallbackIp
    }
    const scopes = scopesMatch?.[1] ?? '';
    const nameMatch = scopes.match(/onvif:\/\/www\.onvif\.org\/name\/([^\s<]+)/i);
    const hwMatch = scopes.match(/onvif:\/\/www\.onvif\.org\/hardware\/([^\s<]+)/i);
    const deviceName = nameMatch
        ? decodeURIComponent(nameMatch[1])
        : hwMatch
            ? decodeURIComponent(hwMatch[1])
            : null;
    const combined = `${rawXAddr} ${scopes}`.toLowerCase();
    const brandHint = combined.includes('ezviz') || combined.includes('hikvision') || combined.includes('cs-c')
        ? 'ezviz'
        : 'generic';
    return {
        ipAddress,
        onvifEndpoint: rawXAddr,
        deviceName,
        brandHint,
    };
}
export async function discoverOnvifDevices(timeoutMs = 1500) {
    return new Promise((resolve) => {
        const hits = new Map();
        const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        const messageId = `uuid:${crypto.randomUUID()}`;
        const probeSoap = `<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"
            xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"
            xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
            xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <e:Header>
    <w:MessageID>${messageId}</w:MessageID>
    <w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>
    <w:Action a:mustUnderstand="true" xmlns:a="http://www.w3.org/2005/08/addressing">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>
  </e:Header>
  <e:Body>
    <d:Probe>
      <d:Types>dn:NetworkVideoTransmitter</d:Types>
    </d:Probe>
  </e:Body>
</e:Envelope>`;
        let settled = false;
        const finish = () => {
            if (settled)
                return;
            settled = true;
            try {
                socket.close();
            }
            catch {
                // ignore close error
            }
            resolve(Array.from(hits.values()));
        };
        socket.on('error', () => finish());
        socket.on('message', (msg, rinfo) => {
            const parsed = parseWsDiscoveryResponse(msg.toString('utf8'), rinfo.address);
            if (parsed) {
                hits.set(parsed.ipAddress, parsed);
            }
        });
        socket.bind(0, '0.0.0.0', () => {
            try {
                socket.setBroadcast(true);
                const buf = Buffer.from(probeSoap, 'utf8');
                socket.send(buf, 0, buf.length, 3702, '239.255.255.250');
            }
            catch {
                finish();
                return;
            }
            setTimeout(finish, timeoutMs);
        });
    });
}
