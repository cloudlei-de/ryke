// Shared by the control API's log endpoint and the post-receive hook, so both
// describe a commit in exactly the same way.

// \x1f separates fields and \x1e ends a record: commit messages may contain
// newlines and tabs but git forbids neither of these control bytes in practice.
export const LOG_FORMAT = "%H%x1f%P%x1f%an <%ae>%x1f%ct%x1f%B%x1e";

export function parseLog(text) {
  const commits = [];
  for (const record of text.split("\x1e")) {
    // `git log --format=` terminates each record with a newline after \x1e.
    const body = record.startsWith("\n") ? record.slice(1) : record;
    if (body === "") continue;
    const [sha, parents, author, committed, ...messageParts] = body.split("\x1f");
    let message = messageParts.join("\x1f");
    // %B is the stored message verbatim; the final newline is framing, not content.
    if (message.endsWith("\n")) message = message.slice(0, -1);
    commits.push({
      sha,
      parents: parents === "" ? [] : parents.split(" "),
      message,
      author,
      at: Number(committed) * 1000,
    });
  }
  return commits;
}
