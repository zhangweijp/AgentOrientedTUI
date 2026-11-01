/**
 * Transformer Helpers (Pure Functions)
 * 
 * Shared utility functions for DOM traversal and payload sanitization.
 * Extracted from pure.ts to support Visitor Pattern refactoring.
 */





// ============================================================================
// Type Guards for DOM Nodes
// ============================================================================

export type DOMNode = Node;

/** Type guard: Check if node is an Element */
export function isElement(node: DOMNode): node is Element {
    return node.nodeType === 1;
}

/** Type guard: Check if node is a Text node */
/**
 * Type guard: Check if node is a Text node
 */
export function isText(node: DOMNode): node is Text {
    return node.nodeType === 3;
}
