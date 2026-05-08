*&---------------------------------------------------------------------*
*& Report ZCLEAN_HELLO_WORLD
*&---------------------------------------------------------------------*
*& A simple demo program following Clean ABAP guidelines.
*&---------------------------------------------------------------------*
REPORT zclean_hello_world.

" Use inline declarations and meaningful variable names
DATA(lv_user_name) = sy-uname.
DATA(lv_has_name)  = xsdbool( lv_user_name IS NOT INITIAL ).

IF lv_has_name = abap_true.
  WRITE: / 'Hello,', lv_user_name, '- welcome to Clean ABAP!'.
ELSE.
  WRITE: / 'Hello, anonymous user - welcome to Clean ABAP!'.
ENDIF.

" Demonstrate a simple loop with inline declaration
DATA:
  lt_messages TYPE TABLE OF string,
  lv_message  TYPE string.

lt_messages = VALUE #(
  ( |Clean ABAP recommends uppercase keywords.| )
  ( |Use ABAP_TRUE and ABAP_FALSE for Booleans.| )
  ( |Prefer XSDBOOL to set Boolean variables.| )
  ( |Format your code before activating.| )
).

SKIP.
WRITE: / 'Clean ABAP Tips:'.
ULINE.

LOOP AT lt_messages INTO lv_message.
  DATA(lv_index) = sy-tabix.
  WRITE: / lv_index, ')', lv_message.
ENDLOOP.
