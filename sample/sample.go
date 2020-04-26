// Package sample is used as test input for golangci action.
package sample

import (
	"crypto/md5"
	"encoding/hex"
)

// Hash~
func Hash(data string) string {
	h := md5.New()
	h.Write([]byte(data))
	return hex.EncodeToString(h.Sum(nil))
}
