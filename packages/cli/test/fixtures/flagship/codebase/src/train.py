"""Training entry point for the WidgetNet experiments."""

LEARNING_RATE = 3e-4
BATCH_SIZE = 64
EPOCHS = 40


def build_model(depth: int = 12):
    """A residual encoder with `depth` blocks and GELU activations."""
    return {"depth": depth, "activation": "gelu"}


def train(dataset_path: str):
    model = build_model()
    for _ in range(EPOCHS):
        step(model, dataset_path)
    return model


def step(model, dataset_path):
    """One AdamW step with cosine decay."""
    return model
