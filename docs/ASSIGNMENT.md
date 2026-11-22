# Assignment — AWS secret leak scanner

This is the single source of truth for the assignment. Workers read this file, never the original PDF.

## Instructions
- Design the solution first, then code.
- Share the code through a public GitHub repo.
- AI tools are allowed.
- Time: up to 3 hours. Language: Go or TypeScript (we use TypeScript). GitHub's SDK is allowed.

## Desired application
For a given repo, scan the commits' content to find leaks of
[AWS access secrets](https://summitroute.com/blog/2018/06/20/aws_security_credential_formats/).

- **Implementation:** pick one.
  - Option 1, GitHub API: use a Personal Access Token
    ([guide](https://docs.github.com/en/enterprise-server@3.9/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)).
    Handle rate limits and pagination.
  - Option 2, git clone: clone programmatically, and delete the files at the end.
- **Documentation:** a short README explaining how to work with the app.

## Requirements
- **Basic**
  - Scan in descending order of commit time, scanning every file diff.
  - If the scan is interrupted, continue from the previous placeholder.
  - For each finding, return the commit info, the committer and the leak value.
- **Advanced**
  - Also scan commits on non-main branches.
  - Write it as a web server that is used through an API.
- **Bonus**
  - Containerize the application.

## What the interviewers will look for (from Maor)
All of the requirements above are expected, including advanced and bonus. The interviewers will also look at:
- How the design handles a large tenant with many branches and commits.
- Fault tolerance.
- Concurrency: they don't expect tests for it, but the design must plan for it.
- Clean architecture.

No test repo is provided; we create our own.
