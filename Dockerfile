# Runs the measurement with no local Python setup.
#
#   docker build -t polyarb .
#   docker run --rm -v "$PWD/recordings:/app/recordings" polyarb measure --hours 48
#
# Deliberately installs only the [dev] extra, never [live] — matching CI. The
# measurement path must work without py-clob-client-v2 or web3 present, and building
# without them means a stray module-scope import fails here rather than in production.
FROM python:3.12-slim

# Unbuffered output: a container whose logs are buffered looks hung during a
# two-day capture, which invites someone to kill it.
ENV PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Dependency layer first so source edits do not re-resolve the whole tree.
COPY pyproject.toml README.md ./
COPY polyarb ./polyarb
RUN pip install -e '.[dev]'

COPY . .

# `recording_dir` defaults to ./recordings relative to WORKDIR, so mounting here
# needs no extra configuration.
VOLUME ["/app/recordings"]

ENTRYPOINT ["polyarb"]
CMD ["--help"]
