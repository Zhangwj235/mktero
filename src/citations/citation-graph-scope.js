export function scopeCitationGraphSnapshot(snapshot, focusItemID) {
    const source = snapshot && typeof snapshot === 'object'
        ? snapshot
        : {};
    const allNodes = Array.isArray(source.nodes) ? source.nodes : [];
    const focus = allNodes.find(node => sameItemID(node?.itemID, focusItemID));
    if (!focus) {
        return {
            ...source,
            nodes: [],
            edges: [],
            selectedItemID: null,
            warnings: [],
        };
    }

    const nodeByID = new Map(allNodes.map(node => [node?.id, node]));
    const edges = (Array.isArray(source.edges) ? source.edges : [])
        .map(edge => ({
            source: edge?.source,
            target: edge?.target,
        }))
        .filter(edge => edge.source === focus.id && nodeByID.has(edge.target));
    const nodeIDs = new Set([focus.id, ...edges.map(edge => edge.target)]);
    const nodes = allNodes
        .filter(node => nodeIDs.has(node?.id))
        .map(node => ({
            ...node,
            inDegree: 0,
            outDegree: 0,
            degree: 0,
        }));
    const scopedByID = new Map(nodes.map(node => [node.id, node]));
    const scopedEdges = edges.filter(edge => (
        scopedByID.has(edge.source) && scopedByID.has(edge.target)
    ));
    for (const edge of scopedEdges) {
        scopedByID.get(edge.source).outDegree++;
        scopedByID.get(edge.target).inDegree++;
    }
    for (const node of nodes) {
        node.degree = node.inDegree + node.outDegree;
    }

    return {
        ...source,
        nodes,
        edges: scopedEdges,
        selectedItemID: focus.itemID,
        warnings: scopeWarnings(source.warnings, nodes, focus.itemID),
    };
}

function scopeWarnings(warnings, nodes, focusItemID) {
    const scoped = (Array.isArray(warnings) ? warnings : []).filter(warning => (
        warning?.itemID === null
        || warning?.itemID === undefined
        || sameItemID(warning.itemID, focusItemID)
    ));
    const replaceable = new Set([
        'missing-identifiers',
        'unresolved-papers',
    ]);
    const preserved = scoped.filter(warning => !replaceable.has(warning?.code));
    const missing = nodes.filter(node => (
        !node.paperID && !node.doi && !node.arxivID
    )).length;
    if (missing) preserved.push({ code: 'missing-identifiers', count: missing });
    const unresolved = nodes.filter(node => !node.paperID).length;
    if (unresolved && scoped.some(warning => warning?.code === 'unresolved-papers')) {
        preserved.push({ code: 'unresolved-papers', count: unresolved });
    }
    return preserved;
}

function sameItemID(left, right) {
    return left !== null
        && left !== undefined
        && right !== null
        && right !== undefined
        && String(left) === String(right);
}
