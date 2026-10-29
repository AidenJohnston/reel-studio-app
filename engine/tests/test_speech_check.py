"""The per-computer thread count (transcribe.choose_threads): fastest among identical transcripts."""
from reelengine import transcribe

SAME = [("And", 0.3, 0.5), ("so,", 0.5, 0.8)]


def run(threads, seconds, words=SAME):
    return {"threads": threads, "seconds": seconds, "words": words}


def test_fastest_count_with_the_same_words_and_times_wins():
    assert transcribe.choose_threads([run(8, 2.6), run(4, 1.4), run(2, 2.2)]) == 4


def test_a_faster_count_that_hears_anything_differently_is_never_chosen():
    moved = [("And", 0.3, 0.5), ("so,", 0.52, 0.8)]                 # one word edge 20 ms later
    assert transcribe.choose_threads([run(8, 2.6), run(4, 1.4, moved), run(2, 2.2)]) == 2
    assert transcribe.choose_threads([run(8, 2.6), run(4, 1.4, moved)]) == 8
