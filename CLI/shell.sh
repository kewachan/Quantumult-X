#!/bin/bash
total_lines=`cat iprange.txt | wc -l`
lines_no=0
echo "["
while read -r line;
do
  lines_no=$(( $lines_no + 1 ));
  echo " {";
  echo "  \"source\": \"${line}\",";
  echo "  \"protocol\": \"all\",";
  echo "  \"isStateless\": \"false\",";
  echo "  \"Description\": \"OCI WAF IP Ranges\"";
  if [[ $lines_no -eq $total_lines ]]; then
   echo " }"; 
  else
   echo " },";
  fi
done < iprange.txt
echo "]"