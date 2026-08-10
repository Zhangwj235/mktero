export function hasActiveMarkdownWrapper(
    source,
    from,
    to,
    opening,
    closing
) {
    const openingFrom = from - opening.length;
    const closingTo = to + closing.length;
    const immediateWrapper = openingFrom >= 0
        && closingTo <= source.length
        && source.slice(openingFrom, from) === opening
        && source.slice(to, closingTo) === closing;
    if (!immediateWrapper || opening !== '*' || closing !== '*') {
        return immediateWrapper;
    }
    return countAdjacentCharacter(source, from, '*', -1) % 2 === 1
        && countAdjacentCharacter(source, to, '*', 1) % 2 === 1;
}

function countAdjacentCharacter(source, position, character, direction) {
    let count = 0;
    let cursor = direction < 0 ? position - 1 : position;
    while (cursor >= 0 && cursor < source.length
        && source.slice(cursor, cursor + 1) === character) {
        count++;
        cursor += direction;
    }
    return count;
}
