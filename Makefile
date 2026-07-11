.PHONY: install test ci format clean

install:
	npm install

test:
	npm test

ci:
	npm test

format:
	@true

clean:
	rm -rf node_modules coverage
