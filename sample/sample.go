// Package sample is used as test input for golangci action.
package sample

import (
	"crypto/md5"
	"encoding/hex"
	"errors"
)

// Hash~
func Hash(data string) string {
	retError()
	retError2()

	h := md5.New()
	h.Write([]byte(data))
	return hex.EncodeToString(h.Sum(nil))
}

func retError() error {
	return errors.New("err")
}

func retError2() error {
	return errors.New("err2")
}
