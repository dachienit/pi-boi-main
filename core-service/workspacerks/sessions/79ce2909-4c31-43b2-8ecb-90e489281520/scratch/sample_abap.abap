REPORT z_sample_abap.

PARAMETERS: p_name TYPE string.

START-OF-SELECTION.
  IF p_name IS INITIAL.
    WRITE: / 'Hello ABAP world!'.
  ELSE.
    WRITE: / 'Hello, ', p_name, '!'.
  ENDIF.
