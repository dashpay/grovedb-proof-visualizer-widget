//! Decode element bytes (the `value` slot of a merk-tree node) into [`ElementView`].

use grovedb_element::{Element, reference_path::ReferencePathType};
use grovedb_version::version::GroveVersion;

use crate::ir::{DisplayKey, ElementView, HexBytes, ReferenceView};

/// Decode element bytes via `Element::deserialize`. Returns
/// [`ElementView::Unknown`] (rather than erroring) when decoding fails — we
/// always want the renderer to have *something* to show.
pub fn decode_element_view(bytes: &[u8]) -> ElementView {
    match Element::deserialize(bytes, GroveVersion::latest()) {
        Ok(elem) => element_to_view(&elem),
        Err(e) => ElementView::Unknown {
            raw_hex: hex::encode(bytes),
            error: e.to_string(),
        },
    }
}

fn element_to_view(elem: &Element) -> ElementView {
    match elem {
        Element::Item(value, flags) => ElementView::Item {
            value: hex::encode(value),
            flags: flags_to_hex(flags),
        },
        Element::Reference(rp, max_hop, flags) => ElementView::Reference {
            reference: reference_to_view(rp),
            max_hop: max_hop.map(|h| h as u8),
            flags: flags_to_hex(flags),
        },
        Element::Tree(merk_root, flags) => ElementView::Tree {
            merk_root: merk_root.as_deref().map(hex::encode),
            flags: flags_to_hex(flags),
        },
        Element::SumItem(sum, flags) => ElementView::SumItem {
            sum: *sum,
            flags: flags_to_hex(flags),
        },
        Element::SumTree(merk_root, sum, flags) => ElementView::SumTree {
            merk_root: merk_root.as_deref().map(hex::encode),
            sum: *sum,
            flags: flags_to_hex(flags),
        },
        Element::BigSumTree(merk_root, sum, flags) => ElementView::BigSumTree {
            merk_root: merk_root.as_deref().map(hex::encode),
            sum: sum.to_string(),
            flags: flags_to_hex(flags),
        },
        Element::CountTree(merk_root, count, flags) => ElementView::CountTree {
            merk_root: merk_root.as_deref().map(hex::encode),
            count: *count,
            flags: flags_to_hex(flags),
        },
        Element::CountSumTree(merk_root, count, sum, flags) => ElementView::CountSumTree {
            merk_root: merk_root.as_deref().map(hex::encode),
            count: *count,
            sum: *sum,
            flags: flags_to_hex(flags),
        },
        Element::ProvableCountTree(merk_root, count, flags) => ElementView::ProvableCountTree {
            merk_root: merk_root.as_deref().map(hex::encode),
            count: *count,
            flags: flags_to_hex(flags),
        },
        Element::ItemWithSumItem(value, sum, flags) => ElementView::ItemWithSumItem {
            value: hex::encode(value),
            sum: *sum,
            flags: flags_to_hex(flags),
        },
        Element::ProvableCountSumTree(merk_root, count, sum, flags) => {
            ElementView::ProvableCountSumTree {
                merk_root: merk_root.as_deref().map(hex::encode),
                count: *count,
                sum: *sum,
                flags: flags_to_hex(flags),
            }
        }
        Element::CommitmentTree(total_count, chunk_power, flags) => ElementView::CommitmentTree {
            total_count: *total_count,
            chunk_power: *chunk_power,
            flags: flags_to_hex(flags),
        },
        Element::MmrTree(mmr_size, flags) => ElementView::MmrTree {
            mmr_size: *mmr_size,
            flags: flags_to_hex(flags),
        },
        Element::BulkAppendTree(total_count, chunk_power, flags) => ElementView::BulkAppendTree {
            total_count: *total_count,
            chunk_power: *chunk_power,
            flags: flags_to_hex(flags),
        },
        Element::DenseAppendOnlyFixedSizeTree(count, height, flags) => {
            ElementView::DenseAppendOnlyFixedSizeTree {
                count: *count,
                height: *height,
                flags: flags_to_hex(flags),
            }
        }
        Element::NonCounted(inner) => ElementView::NonCounted {
            inner: Box::new(element_to_view(inner)),
        },
        Element::NotSummed(inner) => ElementView::NotSummed {
            inner: Box::new(element_to_view(inner)),
        },
    }
}

fn flags_to_hex(flags: &Option<Vec<u8>>) -> Option<HexBytes> {
    flags.as_ref().map(|v| hex::encode(v))
}

fn reference_to_view(rp: &ReferencePathType) -> ReferenceView {
    fn keys(segments: &[Vec<u8>]) -> Vec<DisplayKey> {
        segments.iter().map(|s| DisplayKey::from_bytes(s)).collect()
    }
    match rp {
        ReferencePathType::AbsolutePathReference(path) => {
            ReferenceView::Absolute { path: keys(path) }
        }
        ReferencePathType::UpstreamRootHeightReference(n_keep, path_append) => {
            ReferenceView::UpstreamRootHeight {
                n_keep: *n_keep,
                path_append: keys(path_append),
            }
        }
        ReferencePathType::UpstreamRootHeightWithParentPathAdditionReference(n_keep, path_append) => {
            ReferenceView::UpstreamRootHeightWithParentPathAddition {
                n_keep: *n_keep,
                path_append: keys(path_append),
            }
        }
        ReferencePathType::UpstreamFromElementHeightReference(n_remove, path_append) => {
            ReferenceView::UpstreamFromElementHeight {
                n_remove: *n_remove,
                path_append: keys(path_append),
            }
        }
        ReferencePathType::CousinReference(swap_parent) => ReferenceView::Cousin {
            swap_parent: DisplayKey::from_bytes(swap_parent),
        },
        ReferencePathType::RemovedCousinReference(swap_parent) => ReferenceView::RemovedCousin {
            swap_parent: keys(swap_parent),
        },
        ReferencePathType::SiblingReference(sibling_key) => ReferenceView::Sibling {
            sibling_key: DisplayKey::from_bytes(sibling_key),
        },
    }
}
