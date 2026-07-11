.PHONY: install format lint check test ci clean

install:
	npm install

format:
	npm run format

lint:
	npm run lint

check:
	npm run check

test:
	npm run test

ci:
	npm run ci

clean:
	rm -rf node_modules coverage
