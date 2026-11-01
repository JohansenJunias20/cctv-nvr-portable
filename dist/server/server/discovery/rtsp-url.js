export function buildRtspUrl(opts) {
    const port = opts.port ?? 554;
    const cleanPath = opts.path.startsWith('/') ? opts.path : `/${opts.path}`;
    let authPart = '';
    if (opts.username) {
        const encUser = encodeURIComponent(opts.username);
        const encPass = opts.password !== undefined ? encodeURIComponent(opts.password) : '';
        authPart =
            opts.password !== undefined && opts.password !== ''
                ? `${encUser}:${encPass}@`
                : `${encUser}@`;
    }
    return `rtsp://${authPart}${opts.host}:${port}${cleanPath}`;
}
export function maskRtspUrl(url) {
    const schemeMatch = url.match(/^(rtsps?:\/\/)(.*)$/i);
    if (!schemeMatch)
        return url;
    const [, scheme, remainder] = schemeMatch;
    const slashIdx = remainder.indexOf('/');
    const authority = slashIdx === -1 ? remainder : remainder.slice(0, slashIdx);
    const pathPart = slashIdx === -1 ? '' : remainder.slice(slashIdx);
    // Split at the LAST '@' in authority so raw '@' inside passwords never leaks
    const atIdx = authority.lastIndexOf('@');
    if (atIdx === -1)
        return url;
    const userInfo = authority.slice(0, atIdx);
    const hostPort = authority.slice(atIdx + 1);
    const colonIdx = userInfo.indexOf(':');
    if (colonIdx === -1)
        return url;
    const user = userInfo.slice(0, colonIdx);
    return `${scheme}${user}:***@${hostPort}${pathPart}`;
}
export function extractRtspPath(url) {
    const schemeMatch = url.match(/^rtsps?:\/\/(.*)$/i);
    if (!schemeMatch)
        return '/stream1';
    const remainder = schemeMatch[1];
    const slashIdx = remainder.indexOf('/');
    return slashIdx === -1 ? '/' : remainder.slice(slashIdx);
}
export function rewriteRtspUrlEndpoint(existingUrl, updates) {
    const pathWithQuery = extractRtspPath(existingUrl);
    return buildRtspUrl({
        host: updates.host,
        port: updates.port,
        username: updates.username,
        password: updates.password,
        path: pathWithQuery,
    });
}
const EZVIZ_TEMPLATES = [
    {
        label: 'Ezviz / Hikvision H.264 Stream',
        mainPath: '/h264/ch1/main/av_stream',
        subPath: '/h264/ch1/sub/av_stream',
    },
    {
        label: 'Ezviz / Hikvision ISAPI Channels',
        mainPath: '/Streaming/Channels/101',
        subPath: '/Streaming/Channels/102',
    },
    {
        label: 'Ezviz H.265 / Live',
        mainPath: '/h265/ch1/main/av_stream',
        subPath: '/h265/ch1/sub/av_stream',
    },
];
const GENERIC_TEMPLATES = [
    {
        label: 'TP-Link Tapo / Generic Stream 1',
        mainPath: '/stream1',
        subPath: '/stream2',
    },
    {
        label: 'Dahua / Imou RealMonitor',
        mainPath: '/cam/realmonitor?channel=1&subtype=0',
        subPath: '/cam/realmonitor?channel=1&subtype=1',
    },
    {
        label: 'ONVIF Standard Live',
        mainPath: '/onvif1',
        subPath: '/onvif2',
    },
    {
        label: 'Generic Live Channel 0',
        mainPath: '/live/ch0',
        subPath: '/live/ch1',
    },
];
export function generateCandidateRtspUrls(opts) {
    const ordered = opts.brandHint === 'ezviz'
        ? [...EZVIZ_TEMPLATES, ...GENERIC_TEMPLATES]
        : [...GENERIC_TEMPLATES, ...EZVIZ_TEMPLATES];
    return ordered.map((tpl) => ({
        label: tpl.label,
        mainUrl: buildRtspUrl({
            host: opts.host,
            port: opts.port,
            username: opts.username,
            password: opts.password,
            path: tpl.mainPath,
        }),
        subUrl: tpl.subPath
            ? buildRtspUrl({
                host: opts.host,
                port: opts.port,
                username: opts.username,
                password: opts.password,
                path: tpl.subPath,
            })
            : null,
    }));
}
