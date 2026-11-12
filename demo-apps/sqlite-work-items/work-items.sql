CREATE TABLE work_items (
    id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 9007199254740991),
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    body TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'done')),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991)
);

INSERT INTO work_items (id, title, body, status) VALUES
    (101, 'Review SDK guide', 'Check the public App and Host examples.', 'open'),
    (102, 'Prepare release notes', 'Summarize the changes to App authoring.', 'open');
