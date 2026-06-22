package mainline

// Minimal bencode codec (BEP-3 wire format) — just enough for KRPC (BEP-5) and
// mutable items (BEP-44). stdlib only.
//
// Decoded types:
//   - integers  -> int64
//   - strings   -> string (bencode strings are byte strings; we keep them as Go
//                  strings, which hold arbitrary bytes fine)
//   - lists     -> []interface{}
//   - dicts     -> map[string]interface{}
//
// Encoding accepts int/int64/string/[]byte/[]interface{}/map[string]interface{}.
// Dictionary keys are emitted in lexicographic byte order, as the spec requires —
// this is also what makes BEP-44 signatures reproducible.

import (
	"errors"
	"fmt"
	"sort"
	"strconv"
)

var errBencode = errors.New("bencode: malformed input")

// bencode marshals v into its bencoded byte representation.
func bencode(v interface{}) ([]byte, error) {
	var b []byte
	if err := encodeValue(&b, v); err != nil {
		return nil, err
	}
	return b, nil
}

func encodeValue(b *[]byte, v interface{}) error {
	switch t := v.(type) {
	case int:
		*b = append(*b, 'i')
		*b = strconv.AppendInt(*b, int64(t), 10)
		*b = append(*b, 'e')
	case int64:
		*b = append(*b, 'i')
		*b = strconv.AppendInt(*b, t, 10)
		*b = append(*b, 'e')
	case string:
		*b = strconv.AppendInt(*b, int64(len(t)), 10)
		*b = append(*b, ':')
		*b = append(*b, t...)
	case []byte:
		*b = strconv.AppendInt(*b, int64(len(t)), 10)
		*b = append(*b, ':')
		*b = append(*b, t...)
	case []interface{}:
		*b = append(*b, 'l')
		for _, e := range t {
			if err := encodeValue(b, e); err != nil {
				return err
			}
		}
		*b = append(*b, 'e')
	case map[string]interface{}:
		*b = append(*b, 'd')
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			*b = strconv.AppendInt(*b, int64(len(k)), 10)
			*b = append(*b, ':')
			*b = append(*b, k...)
			if err := encodeValue(b, t[k]); err != nil {
				return err
			}
		}
		*b = append(*b, 'e')
	default:
		return fmt.Errorf("bencode: unsupported type %T", v)
	}
	return nil
}

// bdecode parses a single bencoded value from data.
func bdecode(data []byte) (interface{}, error) {
	d := &decoder{buf: data}
	v, err := d.value()
	if err != nil {
		return nil, err
	}
	return v, nil
}

type decoder struct {
	buf []byte
	pos int
}

func (d *decoder) value() (interface{}, error) {
	if d.pos >= len(d.buf) {
		return nil, errBencode
	}
	switch c := d.buf[d.pos]; {
	case c == 'i':
		return d.integer()
	case c == 'l':
		return d.list()
	case c == 'd':
		return d.dict()
	case c >= '0' && c <= '9':
		return d.str()
	default:
		return nil, errBencode
	}
}

func (d *decoder) integer() (int64, error) {
	d.pos++ // 'i'
	start := d.pos
	for d.pos < len(d.buf) && d.buf[d.pos] != 'e' {
		d.pos++
	}
	if d.pos >= len(d.buf) {
		return 0, errBencode
	}
	n, err := strconv.ParseInt(string(d.buf[start:d.pos]), 10, 64)
	if err != nil {
		return 0, errBencode
	}
	d.pos++ // 'e'
	return n, nil
}

func (d *decoder) str() (string, error) {
	start := d.pos
	for d.pos < len(d.buf) && d.buf[d.pos] != ':' {
		d.pos++
	}
	if d.pos >= len(d.buf) {
		return "", errBencode
	}
	n, err := strconv.Atoi(string(d.buf[start:d.pos]))
	if err != nil || n < 0 {
		return "", errBencode
	}
	d.pos++ // ':'
	if d.pos+n > len(d.buf) {
		return "", errBencode
	}
	s := string(d.buf[d.pos : d.pos+n])
	d.pos += n
	return s, nil
}

func (d *decoder) list() ([]interface{}, error) {
	d.pos++ // 'l'
	out := []interface{}{}
	for d.pos < len(d.buf) && d.buf[d.pos] != 'e' {
		v, err := d.value()
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	if d.pos >= len(d.buf) {
		return nil, errBencode
	}
	d.pos++ // 'e'
	return out, nil
}

func (d *decoder) dict() (map[string]interface{}, error) {
	d.pos++ // 'd'
	out := map[string]interface{}{}
	for d.pos < len(d.buf) && d.buf[d.pos] != 'e' {
		k, err := d.str()
		if err != nil {
			return nil, err
		}
		v, err := d.value()
		if err != nil {
			return nil, err
		}
		out[k] = v
	}
	if d.pos >= len(d.buf) {
		return nil, errBencode
	}
	d.pos++ // 'e'
	return out, nil
}
