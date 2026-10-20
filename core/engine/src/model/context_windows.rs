const CONTEXT_WINDOWS: &[(&str, usize)] = &[
    ("gpt-6.1-sol", 1_050_000),
    ("gpt-6-sol", 1_050_000),
    ("gpt-6-astra", 1_050_000),
    ("gpt-6-luna", 1_050_000),
    ("gpt-5.6-sol", 1_050_000),
    ("gpt-5.6", 1_050_000),
    ("claude-fable-5-1", 1_000_000),
    ("claude-fable-5", 1_000_000),
    ("claude-mythos-5-1", 1_000_000),
    ("claude-mythos-5", 1_000_000),
    ("claude-mythos-preview", 1_000_000),
    ("claude-opus-5-5", 1_000_000),
    ("claude-opus-5", 1_000_000),
    ("claude-opus-4-8", 1_000_000),
    ("claude-opus-4-7", 1_000_000),
    ("claude-opus-4-6", 1_000_000),
    ("claude-sonnet-5-5", 1_000_000),
    ("claude-sonnet-5", 1_000_000),
    ("claude-sonnet-4-6", 1_000_000),
    ("claude-haiku-5-5", 1_000_000),
    ("deepseek-flash", 1_000_000),
    ("deepseek-v4-pro", 1_000_000),
    ("deepseek-v4-flash", 1_000_000),
    ("deepseek-v4-flash-vision-exp", 1_000_000),
    ("glm-5", 200_000),
];

pub(crate) fn known_context_window(model_id: &str) -> Option<usize> {
    CONTEXT_WINDOWS
        .iter()
        .find_map(|(id, tokens)| (*id == model_id).then_some(*tokens))
}
