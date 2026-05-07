function normalizeNode(row) {
    return {
        ...row,
        children: [],
        direct_content_count: Number(row.direct_content_count || 0),
        direct_analyzed_count: Number(row.direct_analyzed_count || 0),
        direct_missing_audio_count: Number(row.direct_missing_audio_count || 0),
        total_content_count: 0,
        total_analyzed_count: 0,
        total_missing_audio_count: 0,
        course_pack_count: 0,
        is_leaf: false,
        depth: 0,
        path_names: []
    };
}

function annotateNode(node, depth = 0, parentPath = []) {
    node.depth = depth;
    node.path_names = [...parentPath, node.name];
    node.is_leaf = !node.children.length;

    let totalContent = node.direct_content_count;
    let totalAnalyzed = node.direct_analyzed_count;
    let totalMissingAudio = node.direct_missing_audio_count;
    let coursePackCount = node.is_leaf ? 1 : 0;

    node.children.forEach((child) => {
        annotateNode(child, depth + 1, node.path_names);
        totalContent += child.total_content_count;
        totalAnalyzed += child.total_analyzed_count;
        totalMissingAudio += child.total_missing_audio_count;
        coursePackCount += child.course_pack_count;
    });

    node.total_content_count = totalContent;
    node.total_analyzed_count = totalAnalyzed;
    node.total_missing_audio_count = totalMissingAudio;
    node.course_pack_count = coursePackCount;
    return node;
}

async function getPodcastCategorySnapshot(query) {
    const [categoryRows, contentStats] = await Promise.all([
        query(
            `SELECT id, name, name_en, parent_id, icon, sort_order, is_active, created_at
             FROM podcast_categories
             ORDER BY parent_id ASC, sort_order ASC, id ASC`
        ),
        query(
            `SELECT category_id,
                    COUNT(*) AS content_count,
                    SUM(CASE WHEN sentences_data IS NOT NULL AND sentences_data <> 'processing' THEN 1 ELSE 0 END) AS analyzed_count,
                    SUM(CASE WHEN female_audio_url IS NULL OR female_audio_url = '' OR chinese_audio_url IS NULL OR chinese_audio_url = '' THEN 1 ELSE 0 END) AS missing_audio_count
             FROM podcast_contents
             WHERE category_id IS NOT NULL
             GROUP BY category_id`
        )
    ]);

    const statMap = new Map(
        contentStats.map((row) => [
            Number(row.category_id),
            {
                direct_content_count: Number(row.content_count || 0),
                direct_analyzed_count: Number(row.analyzed_count || 0),
                direct_missing_audio_count: Number(row.missing_audio_count || 0)
            }
        ])
    );

    const nodeMap = new Map();
    categoryRows.forEach((row) => {
        const node = normalizeNode({
            ...row,
            ...(statMap.get(Number(row.id)) || {})
        });
        nodeMap.set(Number(node.id), node);
    });

    const tree = [];
    nodeMap.forEach((node) => {
        const parentId = Number(node.parent_id || 0);
        const parent = nodeMap.get(parentId);
        if (parent) {
            parent.children.push(node);
        } else {
            tree.push(node);
        }
    });

    tree.forEach((root) => annotateNode(root, 0, []));

    const flat = Array.from(nodeMap.values()).sort((a, b) => {
        if (a.depth !== b.depth) return a.depth - b.depth;
        if (a.parent_id !== b.parent_id) return Number(a.parent_id || 0) - Number(b.parent_id || 0);
        if (a.sort_order !== b.sort_order) return Number(a.sort_order || 0) - Number(b.sort_order || 0);
        return Number(a.id) - Number(b.id);
    });

    const summary = {
        total_category_count: flat.length,
        root_group_count: tree.length,
        course_pack_count: flat.filter((node) => node.is_leaf).length,
        total_content_count: tree.reduce((sum, node) => sum + Number(node.total_content_count || 0), 0),
        total_analyzed_count: tree.reduce((sum, node) => sum + Number(node.total_analyzed_count || 0), 0),
        total_missing_audio_count: tree.reduce((sum, node) => sum + Number(node.total_missing_audio_count || 0), 0)
    };

    return { tree, flat, summary };
}

function collectDescendantIds(flat, targetId) {
    const normalizedTargetId = Number(targetId);
    const parentMap = new Map();

    flat.forEach((node) => {
        const parentId = Number(node.parent_id || 0);
        if (!parentMap.has(parentId)) parentMap.set(parentId, []);
        parentMap.get(parentId).push(Number(node.id));
    });

    const ids = [];
    const stack = [normalizedTargetId];
    while (stack.length) {
        const currentId = stack.pop();
        ids.push(currentId);
        const children = parentMap.get(currentId) || [];
        children.forEach((childId) => stack.push(childId));
    }
    return ids;
}

module.exports = {
    getPodcastCategorySnapshot,
    collectDescendantIds
};
