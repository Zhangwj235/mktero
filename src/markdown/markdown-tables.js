export function parseGFMTableRow(line) {
    let source = String(line || '').trim();
    if (!source.includes('|')) return [];
    if (source.startsWith('|')) source = source.slice(1);
    if (source.endsWith('|') && !source.endsWith('\\|')) {
        source = source.slice(0, -1);
    }

    const cells = [];
    let cell = '';
    for (let index = 0; index < source.length; index++) {
        if (source[index] === '\\' && source[index + 1] === '|') {
            cell += '|';
            index++;
        }
        else if (source[index] === '|') {
            cells.push(cell.trim());
            cell = '';
        }
        else {
            cell += source[index];
        }
    }
    cells.push(cell.trim());
    return cells;
}
