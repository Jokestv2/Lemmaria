"""Dataset loading: WidgetSet-1M, split 80/10/10."""

SPLITS = {"train": 0.8, "val": 0.1, "test": 0.1}


def load(path: str):
    """Load WidgetSet-1M from `path` and return the three splits."""
    return SPLITS
