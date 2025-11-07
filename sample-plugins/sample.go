// Package sample is used as test input for golangci action.
package sample

// comment without a to do
func SomeFunc1() {
	_ = 1 + 1
}

// TODO: do something	// want "TODO comment has no author"
func SomeFunc2() {
	_ = 1 + 2
}

// TODO(): do something // want "TODO comment has no author"
func SomeFunc3() {
	_ = 1 + 3
}

// TODO(dbraley): Do something with the value
func SomeFunc4() {
	_ = 1 + 4
}
