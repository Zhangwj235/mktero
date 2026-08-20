export function citationPaperNodeID(paper) {
    const libraryID = String(paper?.libraryID ?? '');
    const key = String(paper?.key ?? '');
    if (!libraryID || !key) {
        throw new TypeError('Citation papers require a library ID and item key');
    }
    return `${libraryID}:${key}`;
}

export function buildCitationGraph({
    papers,
    records = new Map(),
    selectedItemID = null,
    warnings = [],
}) {
    if (!Array.isArray(papers)) {
        throw new TypeError('Citation graph papers are required');
    }
    const recordMap = records instanceof Map
        ? records
        : new Map(Object.entries(records || {}));
    const nodes = papers.map(paper => ({
        ...paper,
        id: citationPaperNodeID(paper),
        paperID: normalizedIdentifier(recordMap.get(
            citationPaperNodeID(paper)
        )?.paperID),
        inDegree: 0,
        outDegree: 0,
        degree: 0,
    }));
    const graphWarnings = [...(Array.isArray(warnings) ? warnings : [])];
    const indexes = {
        doi: createUniqueIndex(nodes, node => node.doi),
        arxivID: createUniqueIndex(nodes, node => node.arxivID),
    };
    appendAmbiguityWarnings(graphWarnings, indexes);
    const byID = new Map(nodes.map(node => [node.id, node]));
    const edgeByKey = new Map();
    const edges = [];
    for (const source of nodes) {
        const record = recordMap.get(source.id);
        for (const reference of Array.isArray(record?.references)
            ? record.references
            : []) {
            const targetID = matchReference(reference, indexes);
            if (!targetID || targetID === source.id) continue;
            const edgeKey = `${source.id}\u0000${targetID}`;
            const existing = edgeByKey.get(edgeKey);
            if (existing) {
                appendEdgeSources(existing, reference?.sources);
                continue;
            }
            const target = byID.get(targetID);
            if (!target) continue;
            const edge = { source: source.id, target: targetID };
            appendEdgeSources(edge, reference?.sources);
            edgeByKey.set(edgeKey, edge);
            source.outDegree++;
            target.inDegree++;
            edges.push(edge);
        }
    }
    for (const node of nodes) node.degree = node.inDegree + node.outDegree;
    edges.sort((left, right) => (
        left.source.localeCompare(right.source)
        || left.target.localeCompare(right.target)
    ));
    const missingIdentifiers = nodes.filter(node => (
        !node.doi && !node.arxivID
    )).length;
    if (missingIdentifiers) {
        graphWarnings.push({
            code: 'missing-identifiers',
            count: missingIdentifiers,
        });
    }
    const unresolvedPapers = nodes.filter(node => (
        recordMap.get(node.id)?.status === 'unindexed'
    )).length;
    if (unresolvedPapers) {
        graphWarnings.push({
            code: 'unresolved-papers',
            count: unresolvedPapers,
        });
    }
    const selectedExists = nodes.some(node => sameItemID(
        node.itemID,
        selectedItemID
    ));
    return {
        nodes,
        edges,
        selectedItemID: selectedExists ? selectedItemID : null,
        warnings: graphWarnings,
    };
}

function appendEdgeSources(edge, values) {
    const sources = [...new Set([
        ...(Array.isArray(edge.sources) ? edge.sources : []),
        ...(Array.isArray(values) ? values : []),
    ].map(value => typeof value === 'string'
        ? value.trim().toLowerCase().slice(0, 64)
        : '').filter(value => /^[a-z][a-z0-9-]{0,63}$/.test(value)))].sort();
    if (sources.length) edge.sources = sources;
}

function createUniqueIndex(nodes, readValue) {
    const candidates = new Map();
    for (const node of nodes) {
        const value = normalizedIdentifier(readValue(node));
        if (!value) continue;
        const matches = candidates.get(value) || [];
        matches.push(node.id);
        candidates.set(value, matches);
    }
    const unique = new Map();
    const ambiguous = new Map();
    for (const [value, matches] of candidates) {
        if (matches.length === 1) unique.set(value, matches[0]);
        else ambiguous.set(value, matches);
    }
    return { unique, ambiguous };
}

function appendAmbiguityWarnings(warnings, indexes) {
    for (const [identifierType, index] of Object.entries(indexes)) {
        for (const matches of index.ambiguous.values()) {
            warnings.push({
                code: 'ambiguous-identifier',
                identifierType,
                count: matches.length,
            });
        }
    }
}

function matchReference(reference, indexes) {
    for (const [identifierType, value] of [
        ['doi', reference?.doi],
        ['arxivID', reference?.arxivID],
    ]) {
        const targetID = indexes[identifierType].unique.get(
            normalizedIdentifier(value)
        );
        if (targetID) return targetID;
    }
    return null;
}

function normalizedIdentifier(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function sameItemID(left, right) {
    return left !== null
        && left !== undefined
        && right !== null
        && right !== undefined
        && String(left) === String(right);
}
